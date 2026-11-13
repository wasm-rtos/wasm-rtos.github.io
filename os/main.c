/*
 * Browser entry point for wasm-rtos.
 *
 * Build this file with Emscripten together with the kernel sources in
 * os/wasm-rtos and its interpreter, os/wasm-rtos/vm. It supplies the kernel clock port from the
 * browser's clock, a GPIO port for the parts drawn on the page, a display
 * port that paints into framebuffers the page shows, input devices the page
 * reports to, I2C and SPI ports with models of the chips on the buses, and
 * an output port that hands each program's stdout and stderr to the page.
 */

#include "os/wasm-rtos/os.h"
#include "os/wasm-rtos/fs.h"
#include "os/chip_heap.h"

#include <emscripten/emscripten.h>

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * The kernel and the interpreter allocate from the simulated chip's heap
 * (chip_heap.h, forced into every file by build-browser.sh); the page's own
 * parts, which are not on the chip, use the browser's.
 */
#undef malloc
#undef calloc
#undef realloc
#undef free

#define BROWSER_MAX_SLICES_PER_FRAME 64U
/* Keep this aligned with the core scheduler's OS_TASK_SLICE_FUEL value. */
#define BROWSER_FUEL_PER_SLICE 10000U
#define BROWSER_DEFAULT_FUEL_PER_MS 2400U
#define BROWSER_MAX_FUEL_PER_MS 40000U
#define BROWSER_MAX_ELAPSED_BUDGET_MS 100U
#define BROWSER_ERROR_MESSAGE_SIZE 256U
#define BROWSER_TRACE_EVENT_CAPACITY 4096U
/* Dropped files appear here, like an SD card on a board. */
#define BROWSER_FS_MOUNT "/sd"
/* Frames of programs' memory and the slots of the page store (64 MiB). */
#define BROWSER_FRAME_SIZE 4096U
#define BROWSER_PAGE_SLOTS 16384U
/* Tasks the page follows after a wake. */
#define BROWSER_MAX_TASKS 64U
/* Pins GPIO0..GPIO7 of the simulated board. */
#define BROWSER_GPIO_PINS 8U
/* Displays a device profile may have (OS_DISPLAY_MAX). */
#define BROWSER_DISPLAYS 2U

/*
 * The simulated board: what the kernel configured and drove on each pin, and
 * which pins a part on the page pulls to ground (a pressed button).
 */
static struct
{
    uint32_t flags[BROWSER_GPIO_PINS];
    uint8_t driven[BROWSER_GPIO_PINS];
    uint8_t grounded[BROWSER_GPIO_PINS];
} g_board;

static OsStatus browser_gpio_configure(void* context, uint32_t pin, uint32_t flags)
{
    (void)context;
    if (pin >= BROWSER_GPIO_PINS)
    {
        return OS_STATUS_INVALID_ARGUMENT;
    }
    g_board.flags[pin] = flags;
    if ((flags & OS_GPIO_OUTPUT) != 0U)
    {
        g_board.driven[pin] = (flags & OS_GPIO_INIT_HIGH) != 0U ? 1U : 0U;
    }
    return OS_STATUS_OK;
}

static OsStatus browser_gpio_write(void* context, uint32_t pin, uint8_t level)
{
    (void)context;
    if (pin >= BROWSER_GPIO_PINS)
    {
        return OS_STATUS_INVALID_ARGUMENT;
    }
    g_board.driven[pin] = level ? 1U : 0U;
    return OS_STATUS_OK;
}

/* The level on the pin: a push-pull output wins, then a part, then the pulls. */
static uint8_t browser_gpio_level(uint32_t pin)
{
    uint32_t flags = g_board.flags[pin];

    if ((flags & OS_GPIO_OUTPUT) != 0U && !((flags & OS_GPIO_OPEN_DRAIN) != 0U && g_board.driven[pin]))
    {
        return g_board.driven[pin];
    }
    if (g_board.grounded[pin])
    {
        return 0U;
    }
    return (flags & (OS_GPIO_PULL_UP | OS_GPIO_OPEN_DRAIN)) != 0U ? 1U : 0U;
}

static OsStatus browser_gpio_read(void* context, uint32_t pin, uint8_t* out_level)
{
    (void)context;
    if (pin >= BROWSER_GPIO_PINS)
    {
        return OS_STATUS_INVALID_ARGUMENT;
    }
    *out_level = browser_gpio_level(pin);
    return OS_STATUS_OK;
}

static const OsGpioPort g_browser_gpio_port =
{
    NULL, browser_gpio_configure, browser_gpio_write, browser_gpio_read
};

/*
 * The page registers the pins of its device profile (browser_gpio_add_pin).
 * After a sleep the board keeps what it had: the parts keep power, and the
 * kernel sets its pins up again as the programs left them.
 */
static OsStatus browser_gpio_start(int fresh)
{
    if (fresh)
    {
        memset(&g_board, 0, sizeof(g_board));
    }
    return os_gpio_port_set(&g_browser_gpio_port);
}

/*
 * Displays paint into RGBA framebuffers, one per display, that the page
 * copies to a canvas when they changed. Monochrome pixels take the panel's
 * lit color.
 */
typedef struct BrowserDisplay
{
    uint8_t* rgba;
    uint32_t width;
    uint32_t height;
    uint8_t lit[3];
    uint8_t dirty;
    uint8_t brightness;
} BrowserDisplay;

static BrowserDisplay g_displays[BROWSER_DISPLAYS];

static void browser_display_put(BrowserDisplay* display, uint32_t index, uint32_t format, uint32_t pixel)
{
    uint8_t* out = display->rgba + index * 4U;

    if (format == OS_DISPLAY_MONO1)
    {
        out[0] = pixel ? display->lit[0] : 0U;
        out[1] = pixel ? display->lit[1] : 0U;
        out[2] = pixel ? display->lit[2] : 0U;
    }
    else if (format == OS_DISPLAY_RGB565)
    {
        /* Widen 5 and 6 bits to 8 so white stays white. */
        uint32_t red = (pixel >> 11U) & 0x1FU;
        uint32_t green = (pixel >> 5U) & 0x3FU;
        uint32_t blue = pixel & 0x1FU;
        out[0] = (uint8_t)((red << 3U) | (red >> 2U));
        out[1] = (uint8_t)((green << 2U) | (green >> 4U));
        out[2] = (uint8_t)((blue << 3U) | (blue >> 2U));
    }
    else
    {
        out[0] = (uint8_t)(pixel >> 16U);
        out[1] = (uint8_t)(pixel >> 8U);
        out[2] = (uint8_t)pixel;
    }
    out[3] = 255U;
}

static OsStatus browser_display_write(void* context, uint32_t number, uint32_t x, uint32_t y, uint32_t width,
                                      uint32_t height, uint32_t format, const void* pixels, uint32_t size)
{
    BrowserDisplay* display = number < BROWSER_DISPLAYS ? &g_displays[number] : NULL;
    const uint8_t* bytes = (const uint8_t*)pixels;
    uint32_t row_bytes = format == OS_DISPLAY_MONO1 ? (width + 7U) / 8U : 0U;
    uint32_t row;
    uint32_t column;
    (void)context;
    (void)size;

    if (display == NULL || display->rgba == NULL)
    {
        return OS_STATUS_INVALID_ARGUMENT;
    }
    for (row = 0U; row < height; ++row)
    {
        for (column = 0U; column < width; ++column)
        {
            uint32_t pixel;
            if (format == OS_DISPLAY_MONO1)
            {
                pixel = (bytes[row * row_bytes + column / 8U] >> (7U - column % 8U)) & 1U;
            }
            else if (format == OS_DISPLAY_RGB565)
            {
                const uint8_t* p = bytes + (row * width + column) * 2U;
                pixel = (uint32_t)p[0] | ((uint32_t)p[1] << 8U);
            }
            else
            {
                const uint8_t* p = bytes + (row * width + column) * 4U;
                pixel = (uint32_t)p[0] | ((uint32_t)p[1] << 8U) | ((uint32_t)p[2] << 16U);
            }
            browser_display_put(display, (y + row) * display->width + x + column, format, pixel);
        }
    }
    display->dirty = 1U;
    return OS_STATUS_OK;
}

static OsStatus browser_display_fill(void* context, uint32_t number, uint32_t x, uint32_t y, uint32_t width,
                                     uint32_t height, uint32_t format, uint32_t color)
{
    BrowserDisplay* display = number < BROWSER_DISPLAYS ? &g_displays[number] : NULL;
    uint32_t row;
    uint32_t column;
    (void)context;

    if (display == NULL || display->rgba == NULL)
    {
        return OS_STATUS_INVALID_ARGUMENT;
    }
    for (row = 0U; row < height; ++row)
    {
        for (column = 0U; column < width; ++column)
        {
            browser_display_put(display, (y + row) * display->width + x + column, format, color);
        }
    }
    display->dirty = 1U;
    return OS_STATUS_OK;
}

static OsStatus browser_display_set_brightness(void* context, uint32_t number, uint8_t level)
{
    (void)context;
    if (number >= BROWSER_DISPLAYS)
    {
        return OS_STATUS_INVALID_ARGUMENT;
    }
    g_displays[number].brightness = level;
    return OS_STATUS_OK;
}

static const OsDisplayPort g_browser_display_port =
{
    NULL, browser_display_write, browser_display_fill, NULL, browser_display_set_brightness
};

static void browser_display_free_all(void)
{
    uint32_t index;

    for (index = 0U; index < BROWSER_DISPLAYS; ++index)
    {
        free(g_displays[index].rgba);
    }
    memset(g_displays, 0, sizeof(g_displays));
}

/* ---------------------------------------------------------------------------
 * Buses and the chips on them. The chips are models that react to the bytes
 * a program sends, the way the real parts do, so a driver written for the
 * part works here unchanged.
 * ------------------------------------------------------------------------ */

#define BROWSER_CHIPS 4U
#define BROWSER_CHIP_LM75 1U
#define BROWSER_CHIP_GC9A01 2U

/* A temperature sensor: a pointer register, then temperature, configuration, hysteresis, limit. */
typedef struct BrowserLm75
{
    uint8_t pointer;
    int32_t temperature_milli;
    uint8_t config;
    uint16_t registers[4];
} BrowserLm75;

/* A round TFT controller: commands while DC is low, their parameters and pixels while it is high. */
typedef struct BrowserGc9a01
{
    uint32_t dc_pin;
    uint8_t command;
    uint32_t parameter;
    uint8_t parameters[4];
    uint32_t x0, x1, y0, y1;
    uint32_t x, y;
    uint8_t pixel_high;
    uint8_t pixel_half;
    uint8_t madctl;
    uint8_t inverted;
    uint8_t on;
    uint8_t awake;
    BrowserDisplay screen;
} BrowserGc9a01;

typedef struct BrowserChip
{
    uint8_t type;
    uint32_t bus;
    uint32_t address;   /* I2C address, or SPI chip select pin */
    union
    {
        BrowserLm75 lm75;
        BrowserGc9a01 gc9a01;
    } as;
} BrowserChip;

static BrowserChip g_chips[BROWSER_CHIPS];

static double browser_elapsed_now_ms(void);

/*
 * Time on the wire. A transfer takes as long as its bits at the bus's
 * speed. Short ones finish in the call, as drivers poll them; longer ones
 * run in the background, as with DMA: the program waits while the others
 * run, and the step loop reports the end when its time has passed.
 */
#define BROWSER_BACKGROUND_MIN_US 100.0
/* With nothing else to run, the step loop waits this long for a transfer to end within the frame. */
#define BROWSER_WIRE_SPIN_MS 4.0

typedef struct BrowserWire
{
    uint8_t pending;
    double due_ms;
    /* The last transfer, for the bus analyzer. */
    double last_us;
    uint8_t last_background;
} BrowserWire;

/* By bus kind (OS_BUS_I2C, OS_BUS_SPI) and bus number. */
static BrowserWire g_wire[3][2];

static OsStatus browser_wire_start(uint32_t kind, uint32_t bus, double microseconds)
{
    if (bus >= 2U)
    {
        return OS_STATUS_OK;
    }
    g_wire[kind][bus].last_us = microseconds;
    g_wire[kind][bus].last_background = microseconds >= BROWSER_BACKGROUND_MIN_US;
    if (!g_wire[kind][bus].last_background)
    {
        return OS_STATUS_OK;
    }
    g_wire[kind][bus].pending = 1U;
    g_wire[kind][bus].due_ms = browser_elapsed_now_ms() + microseconds / 1000.0;
    return OS_STATUS_PENDING;
}

static void browser_wire_end(uint32_t kind, uint32_t bus)
{
    if (bus < 2U && g_wire[kind][bus].pending)
    {
        g_wire[kind][bus].pending = 0U;
        os_bus_complete(kind, bus, OS_STATUS_OK);
    }
}

/* The kernel needs the transfer over now (a pause, a kill): it is. */
static void browser_i2c_finish(void* context, uint32_t bus)
{
    (void)context;
    browser_wire_end(OS_BUS_I2C, bus);
}

static void browser_spi_finish(void* context, uint32_t bus)
{
    (void)context;
    browser_wire_end(OS_BUS_SPI, bus);
}

/* End the transfers whose time is up; milliseconds until the next one ends, or -1 when none is left. */
static double browser_wire_poll(void)
{
    double now = browser_elapsed_now_ms();
    double next = -1.0;
    uint32_t kind;
    uint32_t bus;

    for (kind = OS_BUS_I2C; kind <= OS_BUS_SPI; ++kind)
    {
        for (bus = 0U; bus < 2U; ++bus)
        {
            BrowserWire* wire = &g_wire[kind][bus];
            if (!wire->pending)
            {
                continue;
            }
            if (now >= wire->due_ms)
            {
                browser_wire_end(kind, bus);
            }
            else if (next < 0.0 || wire->due_ms - now < next)
            {
                next = wire->due_ms - now;
            }
        }
    }
    return next;
}

static BrowserChip* browser_i2c_chip(uint32_t bus, uint32_t address)
{
    uint32_t index;
    for (index = 0U; index < BROWSER_CHIPS; ++index)
    {
        if (g_chips[index].type == BROWSER_CHIP_LM75 && g_chips[index].bus == bus && g_chips[index].address == address)
        {
            return &g_chips[index];
        }
    }
    return NULL;
}

/* LM75 temperature: 11 bits of 1/8 degree, left-aligned in 16 bits. */
static uint16_t browser_lm75_temperature(const BrowserLm75* sensor)
{
    int32_t eighths = sensor->temperature_milli >= 0 ? (sensor->temperature_milli + 62) / 125
                                                     : (sensor->temperature_milli - 62) / 125;
    return (uint16_t)((uint32_t)eighths << 5U);
}

static OsStatus browser_i2c_transaction(void* context, uint32_t bus, uint32_t address, uint32_t frequency_hz,
                                        const OsI2cOp* ops, uint32_t count)
{
    BrowserChip* chip = browser_i2c_chip(bus, address);
    uint32_t index;
    (void)context;
    (void)frequency_hz;

    if (chip == NULL)
    {
        return OS_STATUS_NACK;
    }
    for (index = 0U; index < count; ++index)
    {
        BrowserLm75* sensor = &chip->as.lm75;
        const OsI2cOp* op = &ops[index];
        uint32_t byte;

        /* A write sets the pointer, then fills the register it points at, high byte first. */
        if (op->kind == OS_I2C_WRITE && op->length > 0U)
        {
            sensor->pointer = op->data[0] & 0x03U;
            if (sensor->pointer == 1U && op->length > 1U)
            {
                sensor->config = op->data[1];
            }
            else if (sensor->pointer >= 2U && op->length > 2U)
            {
                sensor->registers[sensor->pointer] = (uint16_t)((op->data[1] << 8U) | op->data[2]);
            }
        }
        else if (op->kind == OS_I2C_READ)
        {
            uint16_t value = sensor->pointer == 0U ? browser_lm75_temperature(sensor)
                           : sensor->pointer == 1U ? (uint16_t)(sensor->config << 8U)
                                                   : sensor->registers[sensor->pointer];
            for (byte = 0U; byte < op->length; ++byte)
            {
                op->data[byte] = (uint8_t)(byte % 2U == 0U ? value >> 8U : value);
            }
        }
    }
    {
        /* 9 clocks a byte, with an address byte for every start, plus start and stop. */
        uint32_t bytes = count > 0U ? count : 1U;
        for (index = 0U; index < count; ++index)
        {
            bytes += ops[index].length;
        }
        return browser_wire_start(OS_BUS_I2C, bus, (9.0 * bytes + 2.0) * 1e6 / (frequency_hz != 0U ? frequency_hz : 100000U));
    }
}

static const OsI2cPort g_browser_i2c_port = { NULL, browser_i2c_transaction, browser_i2c_finish };

/* One pixel of RAMWR, after the controller's address mode (MADCTL) and inversion. */
static void browser_gc9a01_pixel(BrowserGc9a01* panel, uint16_t color)
{
    uint32_t x = panel->x;
    uint32_t y = panel->y;
    uint32_t width = panel->screen.width;
    uint32_t height = panel->screen.height;

    if ((panel->madctl & 0x20U) != 0U)
    {
        uint32_t swap = x;
        x = y;
        y = swap;
    }
    /* The glass shows columns mirrored, so drivers set MX for an upright picture. */
    if ((panel->madctl & 0x40U) == 0U)
    {
        x = width - 1U - x;
    }
    if ((panel->madctl & 0x80U) != 0U)
    {
        y = height - 1U - y;
    }
    if (x < width && y < height)
    {
        /*
         * Like the common round modules: the glass inverts and its subpixels
         * are blue-green-red, so colors come out right only with INVON and
         * the BGR bit of MADCTL, as drivers for these modules set them
         * (MX | BGR for upright, as the GC9A01 drivers send).
         */
        uint16_t shown = panel->inverted ? color : (uint16_t)~color;
        if ((panel->madctl & 0x08U) == 0U)
        {
            shown = (uint16_t)(((shown & 0x1FU) << 11U) | (shown & 0x07E0U) | (shown >> 11U));
        }
        browser_display_put(&panel->screen, y * width + x, OS_DISPLAY_RGB565, shown);
        panel->screen.dirty = 1U;
    }
    /* The window fills left to right, top to bottom, and wraps. */
    if (++panel->x > panel->x1)
    {
        panel->x = panel->x0;
        if (++panel->y > panel->y1)
        {
            panel->y = panel->y0;
        }
    }
}

static void browser_gc9a01_byte(BrowserGc9a01* panel, uint8_t byte, uint8_t data)
{
    if (!data)
    {
        panel->command = byte;
        panel->parameter = 0U;
        panel->pixel_half = 0U;
        switch (byte)
        {
            case 0x11U: panel->awake = 1U; break;                   /* SLPOUT */
            case 0x10U: panel->awake = 0U; break;                   /* SLPIN */
            case 0x29U: panel->on = 1U; panel->screen.dirty = 1U; break;  /* DISPON */
            case 0x28U: panel->on = 0U; panel->screen.dirty = 1U; break;  /* DISPOFF */
            case 0x21U: panel->inverted = 1U; break;                /* INVON */
            case 0x20U: panel->inverted = 0U; break;                /* INVOFF */
            case 0x2CU: panel->x = panel->x0; panel->y = panel->y0; break; /* RAMWR */
            default: break;
        }
        return;
    }
    if (panel->command == 0x2CU || panel->command == 0x3CU)
    {
        /* RAMWR and RAMWRC: RGB565, high byte first. */
        if (!panel->pixel_half)
        {
            panel->pixel_high = byte;
            panel->pixel_half = 1U;
        }
        else
        {
            panel->pixel_half = 0U;
            browser_gc9a01_pixel(panel, (uint16_t)((panel->pixel_high << 8U) | byte));
        }
        return;
    }
    if (panel->parameter < sizeof(panel->parameters))
    {
        panel->parameters[panel->parameter] = byte;
    }
    ++panel->parameter;
    if (panel->command == 0x2AU && panel->parameter == 4U)
    {
        panel->x0 = (uint32_t)(panel->parameters[0] << 8U) | panel->parameters[1];
        panel->x1 = (uint32_t)(panel->parameters[2] << 8U) | panel->parameters[3];
    }
    else if (panel->command == 0x2BU && panel->parameter == 4U)
    {
        panel->y0 = (uint32_t)(panel->parameters[0] << 8U) | panel->parameters[1];
        panel->y1 = (uint32_t)(panel->parameters[2] << 8U) | panel->parameters[3];
    }
    else if (panel->command == 0x36U && panel->parameter == 1U)
    {
        panel->madctl = byte;
    }
}

static OsStatus browser_spi_transaction(void* context, uint32_t bus, uint32_t mode, uint32_t frequency_hz,
                                        const OsSpiOp* ops, uint32_t count)
{
    uint32_t chip_index;
    (void)context;
    (void)mode;

    for (chip_index = 0U; chip_index < BROWSER_CHIPS; ++chip_index)
    {
        BrowserChip* chip = &g_chips[chip_index];
        uint32_t index;

        /* Only the chip whose chip select is low listens. */
        if (chip->type != BROWSER_CHIP_GC9A01 || chip->bus != bus || browser_gpio_level(chip->address) != 0U)
        {
            continue;
        }
        for (index = 0U; index < count; ++index)
        {
            const OsSpiOp* op = &ops[index];
            uint8_t data = browser_gpio_level(chip->as.gc9a01.dc_pin);
            uint32_t byte;
            if (op->write == NULL)
            {
                continue;
            }
            for (byte = 0U; byte < op->length; ++byte)
            {
                browser_gc9a01_byte(&chip->as.gc9a01, op->write[byte], data);
            }
        }
    }
    /* Nothing drives MISO: reads see zeros. Eight clocks a byte, and the delays. */
    {
        uint32_t index;
        double microseconds = 0.0;
        for (index = 0U; index < count; ++index)
        {
            if (ops[index].kind == OS_SPI_DELAY_US)
            {
                microseconds += ops[index].length;
                continue;
            }
            if (ops[index].read != NULL)
            {
                memset(ops[index].read, 0, ops[index].length);
            }
            microseconds += 8.0 * ops[index].length * 1e6 / (frequency_hz != 0U ? frequency_hz : 1000000U);
        }
        return browser_wire_start(OS_BUS_SPI, bus, microseconds);
    }
}

static const OsSpiPort g_browser_spi_port = { NULL, browser_spi_transaction, browser_spi_finish };

/*
 * The bus analyzer: the last transactions with their program, device, the
 * first bytes each way, and the GPIO levels when they ran (data/command
 * lines are pins).
 */
#define BROWSER_BUS_EVENTS 1024U
#define BROWSER_BUS_BYTES 16U

typedef struct BrowserBusEvent
{
    double time_ms;
    uint32_t task_id;
    uint32_t kind;
    uint32_t bus;
    uint32_t device;
    int32_t status;
    uint32_t written;
    uint32_t read;
    uint32_t frequency_hz;
    uint32_t pins;
    uint32_t ops;
    uint8_t out_bytes[BROWSER_BUS_BYTES];
    uint8_t in_bytes[BROWSER_BUS_BYTES];
    uint32_t wire_us;
    uint32_t background;
} BrowserBusEvent;

static BrowserBusEvent g_bus_events[BROWSER_BUS_EVENTS];
static uint32_t g_bus_next_sequence = 1U;

static void browser_bus_trace(void* context, const OsBusTrace* trace)
{
    BrowserBusEvent* event = &g_bus_events[(g_bus_next_sequence - 1U) % BROWSER_BUS_EVENTS];
    uint32_t out_count = 0U;
    uint32_t in_count = 0U;
    uint32_t index;
    uint32_t pin;
    (void)context;

    memset(event, 0, sizeof(*event));
    event->time_ms = browser_elapsed_now_ms();
    event->task_id = trace->task_id;
    event->kind = trace->kind;
    event->bus = trace->bus;
    event->device = trace->device;
    event->status = (int32_t)trace->status;
    event->frequency_hz = trace->frequency_hz;
    event->ops = trace->count;
    if (trace->bus < 2U && (trace->kind == OS_BUS_I2C || trace->kind == OS_BUS_SPI))
    {
        event->wire_us = (uint32_t)(g_wire[trace->kind][trace->bus].last_us + 0.5);
        event->background = g_wire[trace->kind][trace->bus].last_background;
    }
    for (pin = 0U; pin < BROWSER_GPIO_PINS; ++pin)
    {
        event->pins |= (uint32_t)browser_gpio_level(pin) << pin;
    }
    for (index = 0U; index < trace->count; ++index)
    {
        const uint8_t* out = NULL;
        const uint8_t* in = NULL;
        uint32_t length = 0U;
        uint32_t byte;

        if (trace->kind == OS_BUS_I2C)
        {
            const OsI2cOp* op = &((const OsI2cOp*)trace->ops)[index];
            length = op->length;
            out = op->kind == OS_I2C_WRITE ? op->data : NULL;
            in = op->kind == OS_I2C_READ ? op->data : NULL;
        }
        else
        {
            const OsSpiOp* op = &((const OsSpiOp*)trace->ops)[index];
            length = op->kind == OS_SPI_DELAY_US ? 0U : op->length;
            out = op->write;
            in = op->read;
        }
        if (out != NULL)
        {
            event->written += length;
            for (byte = 0U; byte < length && out_count < BROWSER_BUS_BYTES; ++byte)
            {
                event->out_bytes[out_count++] = out[byte];
            }
        }
        if (in != NULL && trace->status == OS_STATUS_OK)
        {
            event->read += length;
            for (byte = 0U; byte < length && in_count < BROWSER_BUS_BYTES; ++byte)
            {
                event->in_bytes[in_count++] = in[byte];
            }
        }
    }
    ++g_bus_next_sequence;
}

static void browser_chips_free_all(void)
{
    uint32_t index;
    for (index = 0U; index < BROWSER_CHIPS; ++index)
    {
        if (g_chips[index].type == BROWSER_CHIP_GC9A01)
        {
            free(g_chips[index].as.gc9a01.screen.rgba);
        }
    }
    memset(g_chips, 0, sizeof(g_chips));
    memset(g_wire, 0, sizeof(g_wire));
    memset(g_bus_events, 0, sizeof(g_bus_events));
    g_bus_next_sequence = 1U;
}

/*
 * The chip's page stores (docs/decisions.md, 1 and 2; the kernel's decision
 * 10): frames live in JavaScript, one Uint8Array per slot of each store, so
 * a frame sent out really leaves the runtime's memory. A store in memory
 * answers in the call; one that takes its time, as an SD card does on the
 * board port, makes the whole chip wait for each frame: the page cannot
 * block, so the time is owed, and the scheduler runs no slice until the
 * chip's clock has paid it (browser_runtime_step).
 */
EM_JS(void, browser_page_write_js, (uint32_t store, uint32_t slot, const void* frame, uint32_t size), {
    const stores = Module.pageSlots || (Module.pageSlots = []);
    const slots = stores[store] || (stores[store] = new Map());
    slots.set(slot, HEAPU8.slice(frame, frame + size));
});

EM_JS(int, browser_page_read_js, (uint32_t store, uint32_t slot, void* frame, uint32_t size), {
    const slots = Module.pageSlots && Module.pageSlots[store];
    const stored = slots && slots.get(slot);
    if (!stored || stored.length !== size) return 1;
    HEAPU8.set(stored, frame);
    return 0;
});

EM_JS(void, browser_page_clear_js, (void), {
    Module.pageSlots = [];
});

#define BROWSER_STORES 4U

typedef struct BrowserStore
{
    OsPageStore store;
    uint32_t index;
    uint32_t write_us;
    uint32_t read_us;
    uint32_t priority;
} BrowserStore;

/* The chip's stores: the first sets the RAM budget, the others give slots. */
static BrowserStore g_stores[BROWSER_STORES];
static uint32_t g_store_count;
static double g_page_owed_until_ms;
static double browser_elapsed_now_ms(void);

static void browser_page_owe(uint32_t us)
{
    double now = browser_elapsed_now_ms();
    if (us != 0U)
    {
        g_page_owed_until_ms = (g_page_owed_until_ms > now ? g_page_owed_until_ms : now) + us / 1000.0;
    }
}

static OsStatus browser_page_write(void* context, uint32_t slot, const void* frame)
{
    BrowserStore* store = (BrowserStore*)context;
    browser_page_owe(store->write_us);
    browser_page_write_js(store->index, slot, frame, BROWSER_FRAME_SIZE);
    return OS_STATUS_OK;
}

static OsStatus browser_page_read(void* context, uint32_t slot, void* frame)
{
    BrowserStore* store = (BrowserStore*)context;
    browser_page_owe(store->read_us);
    return browser_page_read_js(store->index, slot, frame, BROWSER_FRAME_SIZE) == 0 ? OS_STATUS_OK : OS_STATUS_ERROR;
}

static void browser_store_make(BrowserStore* store, uint32_t index, uint32_t slots, uint32_t frames, uint32_t write_us,
                               uint32_t read_us, uint32_t priority)
{
    memset(store, 0, sizeof(*store));
    store->index = index;
    store->write_us = write_us;
    store->read_us = read_us;
    store->priority = priority;
    store->store.context = store;
    store->store.slots = slots != 0U ? slots : BROWSER_PAGE_SLOTS;
    store->store.ram_frames = frames;
    store->store.write = browser_page_write;
    store->store.read = browser_page_read;
}

/* The chip's stores into the kernel, at every start of the board. */
static OsStatus browser_stores_start(void)
{
    OsStatus status = OS_STATUS_OK;
    uint32_t index;

    browser_page_clear_js();
    g_page_owed_until_ms = 0.0;
    if (g_store_count == 0U)
    {
        return os_page_store_set(NULL);
    }
    status = os_page_store_set(&g_stores[0].store);
    if (status == OS_STATUS_OK)
    {
        status = os_page_store_priority(&g_stores[0].store, g_stores[0].priority);
    }
    for (index = 1U; index < g_store_count && status == OS_STATUS_OK; ++index)
    {
        status = os_page_store_add(&g_stores[index].store, g_stores[index].priority);
    }
    return status;
}

/* The page keeps a log per program; it gets the bytes as written. */
EM_JS(void, browser_output_to_page, (uint32_t task_id, uint32_t fd, const void* data, uint32_t size), {
    if (Module.onProgramOutput) {
        Module.onProgramOutput(task_id, fd, HEAPU8.slice(data, data + size));
    }
});

static void browser_output_write(void* context, uint32_t task_id, uint32_t fd, const void* data, uint32_t size)
{
    (void)context;
    browser_output_to_page(task_id, fd, data, size);
}

static const OsOutputPort g_browser_output_port =
{
    NULL, browser_output_write
};

typedef struct BrowserTaskRecord
{
    uint32_t task_id;
    uint32_t observed_run_count;
    /* Browser time the task's slices took. */
    double cpu_ms;
    OsTaskHandle task;
    struct BrowserTaskRecord* next;
} BrowserTaskRecord;

typedef struct BrowserTraceEvent
{
    uint32_t sequence;
    uint32_t task_id;
    double started_at_ms;
    double duration_ms;
} BrowserTraceEvent;

static BrowserTaskRecord* g_task_records;
static double g_start_time_ms;
static uint32_t g_clock_now_ms;
static uint32_t g_fuel_per_ms = BROWSER_DEFAULT_FUEL_PER_MS;
static uint32_t g_last_budget_time_ms;
static uint32_t g_scheduled_slice_count;
static double g_fuel_budget;
static BrowserTraceEvent g_trace_events[BROWSER_TRACE_EVENT_CAPACITY];
static uint32_t g_trace_next_sequence = 1U;
static uint32_t g_trace_event_count;
static int g_runtime_initialized;
/* Asleep: the system is saved in the page and the kernel is down. */
static int g_asleep;
static char g_error_message[BROWSER_ERROR_MESSAGE_SIZE];

static double browser_elapsed_now_ms(void)
{
    double elapsed_ms;

    if (g_start_time_ms == 0.0)
    {
        return 0.0;
    }

    elapsed_ms = emscripten_get_now() - g_start_time_ms;
    return elapsed_ms > 0.0 ? elapsed_ms : 0.0;
}

static uint32_t browser_clock_now_ms(void* context)
{
    return context != NULL ? *(const uint32_t*)context : 0U;
}

static BrowserTaskRecord* browser_find_record(uint32_t task_id)
{
    BrowserTaskRecord* record = g_asleep ? NULL : g_task_records;

    while (record != NULL)
    {
        if (record->task_id == task_id)
        {
            return record;
        }
        record = record->next;
    }

    return NULL;
}

static void browser_trace_reset(void)
{
    memset(g_trace_events, 0, sizeof(g_trace_events));
    g_trace_next_sequence = 1U;
    g_trace_event_count = 0U;
}

static void browser_trace_append(uint32_t task_id, double started_at_ms, double duration_ms)
{
    uint32_t sequence = g_trace_next_sequence;
    BrowserTraceEvent* event = &g_trace_events[(sequence - 1U) % BROWSER_TRACE_EVENT_CAPACITY];

    event->sequence = sequence;
    event->task_id = task_id;
    event->started_at_ms = started_at_ms;
    event->duration_ms = duration_ms > 0.0 ? duration_ms : 0.0;

    ++g_trace_next_sequence;
    if (g_trace_event_count < BROWSER_TRACE_EVENT_CAPACITY)
    {
        ++g_trace_event_count;
    }
}

static void browser_trace_capture_slice(double started_at_ms, double finished_at_ms)
{
    BrowserTaskRecord* record = g_task_records;

    while (record != NULL)
    {
        uint32_t run_count = os_task_get_run_count(record->task);

        if (run_count > record->observed_run_count)
        {
            record->observed_run_count = run_count;
            record->cpu_ms += finished_at_ms - started_at_ms;
            browser_trace_append(record->task_id, started_at_ms, finished_at_ms - started_at_ms);
            return;
        }

        record->observed_run_count = run_count;
        record = record->next;
    }
}

static const BrowserTraceEvent* browser_trace_find(uint32_t sequence)
{
    const BrowserTraceEvent* event;

    if (sequence == 0U || g_trace_event_count == 0U)
    {
        return NULL;
    }

    event = &g_trace_events[(sequence - 1U) % BROWSER_TRACE_EVENT_CAPACITY];
    return event->sequence == sequence ? event : NULL;
}

static char* browser_duplicate_string(const char* value)
{
    size_t length;
    char* copy;

    if (value == NULL)
    {
        return NULL;
    }

    length = strlen(value);
    copy = (char*)malloc(length + 1U);
    if (copy == NULL)
    {
        return NULL;
    }

    memcpy(copy, value, length + 1U);
    return copy;
}

static void browser_remove_record(BrowserTaskRecord* target)
{
    BrowserTaskRecord** link = &g_task_records;

    while (*link != NULL)
    {
        if (*link == target)
        {
            *link = target->next;
            free(target);
            return;
        }
        link = &(*link)->next;
    }
}

static void browser_free_all_records(void)
{
    BrowserTaskRecord* record = g_task_records;

    while (record != NULL)
    {
        BrowserTaskRecord* next = record->next;
        free(record);
        record = next;
    }

    g_task_records = NULL;
}

static void browser_set_error(const char* operation, OsStatus status)
{
    const char* phase = os_get_last_error_phase();
    const char* result = os_get_last_error_result();
    const char* task_name = os_get_last_error_task_name();

    snprintf(
        g_error_message,
        sizeof(g_error_message),
        "%s failed: status=%d phase=%s task=%s result=%s",
        operation != NULL ? operation : "operation",
        (int)status,
        phase != NULL ? phase : "none",
        task_name != NULL ? task_name : "none",
        result != NULL ? result : "none"
    );
}

static void browser_clear_error(void)
{
    g_error_message[0] = '\0';
}

/* ---------------------------------------------------------------------------
 * Browser file store
 *
 * Files the user drops into the page live in memory and are mounted at
 * BROWSER_FS_MOUNT, so programs see them through the kernel VFS like an SD
 * card. A program started from the store runs in place (map); a file that is
 * replaced or removed while a reader still has it open is freed on the last
 * close. Directories exist implicitly, as prefixes of file paths.
 * ------------------------------------------------------------------------ */

typedef struct BrowserFile
{
    char* path; /* relative to the mount: no leading or trailing '/' */
    uint8_t* data;
    uint32_t size;
    uint32_t open_count;
    uint8_t removed;
    struct BrowserFile* next;
} BrowserFile;

static BrowserFile* g_files;

static void browser_file_free(BrowserFile* file)
{
    free(file->path);
    free(file->data);
    free(file);
}

/* Unlink and free removed files nobody has open any more. */
static void browser_files_collect(void)
{
    BrowserFile** link = &g_files;

    while (*link != NULL)
    {
        BrowserFile* file = *link;
        if (file->removed && file->open_count == 0U)
        {
            *link = file->next;
            browser_file_free(file);
        }
        else
        {
            link = &file->next;
        }
    }
}

static BrowserFile* browser_file_find(const char* path)
{
    BrowserFile* file;

    for (file = g_files; file != NULL; file = file->next)
    {
        if (!file->removed && strcmp(file->path, path) == 0)
        {
            return file;
        }
    }
    return NULL;
}

/* True when path names a directory: the root, or a prefix of a file path. */
static int browser_dir_exists(const char* path)
{
    size_t length = strlen(path);
    BrowserFile* file;

    if (length == 0U)
    {
        return 1;
    }
    for (file = g_files; file != NULL; file = file->next)
    {
        if (!file->removed && strncmp(file->path, path, length) == 0 && file->path[length] == '/')
        {
            return 1;
        }
    }
    return 0;
}

static OsStatus browser_fs_stat(void* context, const char* path, OsFsStat* out_stat)
{
    BrowserFile* file = browser_file_find(path);
    (void)context;

    if (file != NULL)
    {
        out_stat->type = OS_FS_TYPE_FILE;
        out_stat->size = file->size;
        return OS_STATUS_OK;
    }
    if (browser_dir_exists(path))
    {
        out_stat->type = OS_FS_TYPE_DIRECTORY;
        out_stat->size = 0U;
        return OS_STATUS_OK;
    }
    return OS_STATUS_FILE_NOT_FOUND;
}

static OsStatus browser_fs_open(void* context, const char* path, void** out_handle)
{
    BrowserFile* file = browser_file_find(path);
    (void)context;

    if (file == NULL)
    {
        return browser_dir_exists(path) ? OS_STATUS_IS_A_DIRECTORY : OS_STATUS_FILE_NOT_FOUND;
    }
    ++file->open_count;
    *out_handle = file;
    return OS_STATUS_OK;
}

static OsStatus browser_fs_read(
    void* context,
    void* handle,
    uint64_t offset,
    void* buffer,
    uint32_t length,
    uint32_t* out_read
)
{
    BrowserFile* file = (BrowserFile*)handle;
    (void)context;

    *out_read = 0U;
    if (offset >= file->size)
    {
        return OS_STATUS_OK;
    }
    if ((uint64_t)length > file->size - offset)
    {
        length = (uint32_t)(file->size - offset);
    }
    memcpy(buffer, file->data + offset, length);
    *out_read = length;
    return OS_STATUS_OK;
}

static void browser_fs_close(void* context, void* handle)
{
    BrowserFile* file = (BrowserFile*)handle;
    (void)context;

    if (file->open_count > 0U)
    {
        --file->open_count;
    }
    if (file->removed && file->open_count == 0U)
    {
        browser_files_collect();
    }
}

/* Children of path in the order their files were added, each name once. */
static OsStatus browser_fs_read_dir(void* context, const char* path, uint32_t index, OsFsDirEntry* out_entry)
{
    size_t path_length = strlen(path);
    uint32_t found = 0U;
    BrowserFile* file;
    (void)context;

    if (browser_file_find(path) != NULL)
    {
        return OS_STATUS_NOT_A_DIRECTORY;
    }
    if (!browser_dir_exists(path))
    {
        return OS_STATUS_FILE_NOT_FOUND;
    }

    for (file = g_files; file != NULL; file = file->next)
    {
        const char* rest;
        const char* slash;
        size_t child_length;
        BrowserFile* earlier;
        int duplicate = 0;

        if (file->removed)
        {
            continue;
        }
        if (path_length == 0U)
        {
            rest = file->path;
        }
        else if (strncmp(file->path, path, path_length) == 0 && file->path[path_length] == '/')
        {
            rest = file->path + path_length + 1U;
        }
        else
        {
            continue;
        }

        slash = strchr(rest, '/');
        child_length = slash != NULL ? (size_t)(slash - rest) : strlen(rest);
        if (child_length > OS_FS_NAME_MAX)
        {
            continue;
        }

        /* Skip a child an earlier file already produced. */
        for (earlier = g_files; earlier != file && !duplicate; earlier = earlier->next)
        {
            const char* earlier_rest = earlier->path + (path_length == 0U ? 0U : path_length + 1U);
            if (earlier->removed)
            {
                continue;
            }
            if (path_length != 0U &&
                (strncmp(earlier->path, path, path_length) != 0 || earlier->path[path_length] != '/'))
            {
                continue;
            }
            duplicate = strncmp(earlier_rest, rest, child_length) == 0 &&
                        (earlier_rest[child_length] == '\0' || earlier_rest[child_length] == '/');
        }
        if (duplicate)
        {
            continue;
        }

        if (found == index)
        {
            memcpy(out_entry->name, rest, child_length);
            out_entry->name[child_length] = '\0';
            out_entry->type = slash != NULL ? OS_FS_TYPE_DIRECTORY : OS_FS_TYPE_FILE;
            return OS_STATUS_OK;
        }
        ++found;
    }
    return OS_STATUS_END_OF_DIRECTORY;
}

/* On a chip whose files are on an SD card, a program is read into the chip's RAM, as on the board. */
static uint8_t g_files_on_card;

static const uint8_t* browser_fs_map(void* context, void* handle, uint64_t* out_size)
{
    BrowserFile* file = (BrowserFile*)handle;
    (void)context;

    if (g_files_on_card)
    {
        return NULL;
    }
    *out_size = file->size;
    return file->data;
}

static const OsFsDriver g_browser_fs_driver = {
    browser_fs_stat,
    browser_fs_open,
    browser_fs_read,
    browser_fs_close,
    browser_fs_read_dir,
    browser_fs_map
};

/* A relative path of non-empty segments other than "." and "..". */
static int browser_fs_path_is_valid(const char* path)
{
    const char* segment = path;
    size_t length;

    if (path == NULL || path[0] == '\0' || path[0] == '/')
    {
        return 0;
    }
    length = strlen(path);
    if (length + sizeof(BROWSER_FS_MOUNT) + 1U > OS_FS_PATH_MAX)
    {
        return 0;
    }
    while (*segment != '\0')
    {
        const char* slash = strchr(segment, '/');
        size_t segment_length = slash != NULL ? (size_t)(slash - segment) : strlen(segment);

        if (segment_length == 0U || segment_length > OS_FS_NAME_MAX ||
            (segment_length == 1U && segment[0] == '.') ||
            (segment_length == 2U && segment[0] == '.' && segment[1] == '.'))
        {
            return 0;
        }
        if (slash == NULL)
        {
            break;
        }
        segment = slash + 1;
    }
    return segment[0] != '\0';
}

/* Mark every file at path, or below it when it is a directory, as removed. */
static uint32_t browser_files_remove_path(const char* path)
{
    size_t length = strlen(path);
    uint32_t removed = 0U;
    BrowserFile* file;

    for (file = g_files; file != NULL; file = file->next)
    {
        if (!file->removed && strncmp(file->path, path, length) == 0 &&
            (file->path[length] == '\0' || file->path[length] == '/'))
        {
            file->removed = 1U;
            ++removed;
        }
    }
    browser_files_collect();
    return removed;
}

/* Store a copy of data at path (relative to the mount), replacing a file there. */
EMSCRIPTEN_KEEPALIVE
int browser_fs_write(const char* path, const uint8_t* data, uint32_t size)
{
    BrowserFile* file;
    BrowserFile** tail;
    const char* slash;

    if (!browser_fs_path_is_valid(path) || (data == NULL && size != 0U))
    {
        browser_set_error("browser_fs_write", OS_STATUS_INVALID_ARGUMENT);
        return (int)OS_STATUS_INVALID_ARGUMENT;
    }
    if (browser_dir_exists(path))
    {
        browser_set_error("browser_fs_write", OS_STATUS_IS_A_DIRECTORY);
        return (int)OS_STATUS_IS_A_DIRECTORY;
    }
    /* Every parent must be a directory, not a file. */
    for (slash = strchr(path, '/'); slash != NULL; slash = strchr(slash + 1, '/'))
    {
        BrowserFile* parent;
        for (parent = g_files; parent != NULL; parent = parent->next)
        {
            if (!parent->removed && strlen(parent->path) == (size_t)(slash - path) &&
                strncmp(parent->path, path, (size_t)(slash - path)) == 0)
            {
                browser_set_error("browser_fs_write", OS_STATUS_NOT_A_DIRECTORY);
                return (int)OS_STATUS_NOT_A_DIRECTORY;
            }
        }
    }

    file = (BrowserFile*)calloc(1U, sizeof(BrowserFile));
    if (file != NULL)
    {
        file->path = browser_duplicate_string(path);
        file->data = (uint8_t*)malloc(size != 0U ? size : 1U);
    }
    if (file == NULL || file->path == NULL || file->data == NULL)
    {
        if (file != NULL)
        {
            browser_file_free(file);
        }
        browser_set_error("browser_fs_write", OS_STATUS_OUT_OF_MEMORY);
        return (int)OS_STATUS_OUT_OF_MEMORY;
    }
    if (size != 0U)
    {
        memcpy(file->data, data, size);
    }
    file->size = size;

    (void)browser_files_remove_path(path);
    for (tail = &g_files; *tail != NULL; tail = &(*tail)->next)
    {
    }
    *tail = file;
    browser_clear_error();
    return (int)OS_STATUS_OK;
}

/* Remove a file, or a directory with everything below it. */
EMSCRIPTEN_KEEPALIVE
int browser_fs_remove(const char* path)
{
    if (!browser_fs_path_is_valid(path))
    {
        browser_set_error("browser_fs_remove", OS_STATUS_INVALID_ARGUMENT);
        return (int)OS_STATUS_INVALID_ARGUMENT;
    }
    if (browser_files_remove_path(path) == 0U)
    {
        browser_set_error("browser_fs_remove", OS_STATUS_FILE_NOT_FOUND);
        return (int)OS_STATUS_FILE_NOT_FOUND;
    }
    browser_clear_error();
    return (int)OS_STATUS_OK;
}

/*
 * Entry index of the absolute VFS directory path: writes its name and returns
 * its OsFsType, or the negated OsStatus (END_OF_DIRECTORY ends the listing).
 */
EMSCRIPTEN_KEEPALIVE
int browser_fs_list(const char* path, uint32_t index, char* out_name, uint32_t name_size)
{
    OsFsDirEntry entry;
    OsStatus status;

    if (path == NULL || out_name == NULL || name_size == 0U)
    {
        return -(int)OS_STATUS_INVALID_ARGUMENT;
    }
    status = os_fs_read_dir(path, index, &entry);
    if (status != OS_STATUS_OK)
    {
        return -(int)status;
    }
    if (strlen(entry.name) >= name_size)
    {
        return -(int)OS_STATUS_BUFFER_TOO_SMALL;
    }
    memcpy(out_name, entry.name, strlen(entry.name) + 1U);
    return (int)entry.type;
}

/* Size of the file at the absolute VFS path, or -1 when it is not a file. */
EMSCRIPTEN_KEEPALIVE
double browser_fs_file_size(const char* path)
{
    OsFsStat stat;

    if (path == NULL || os_fs_stat(path, &stat) != OS_STATUS_OK || stat.type != OS_FS_TYPE_FILE)
    {
        return -1.0;
    }
    return (double)stat.size;
}

/*
 * The bytes of a file in the page's store (a path relative to /sd, as the
 * store keeps it), or NULL: for a board on the serial cable reading the
 * page's files. Its size is browser_fs_file_size's.
 */
EMSCRIPTEN_KEEPALIVE
const uint8_t* browser_fs_file_data(const char* relative)
{
    BrowserFile* file = relative != NULL ? browser_file_find(relative) : NULL;
    return file != NULL ? file->data : NULL;
}

static void browser_clock_start(void)
{
    g_start_time_ms = emscripten_get_now();
}

static void browser_clock_stop(void)
{
    g_start_time_ms = 0.0;
}

static uint32_t browser_time_ms(void)
{
    return (uint32_t)browser_elapsed_now_ms();
}

/*
 * The kernel and its ports, as at every start of the board. fresh: a power-on
 * (the board's parts start afresh too); else a wake from sleep, where the
 * parts keep their state and the page registers the device profile again.
 */
static OsStatus browser_kernel_start(int fresh)
{
    OsClockPort clock_port;
    OsStatus status;

    browser_clock_start();
    status = os_init();
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_init", status);
        browser_clock_stop();
        return status;
    }

    status = os_fs_mount(BROWSER_FS_MOUNT, &g_browser_fs_driver, NULL);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_fs_mount", status);
        os_shutdown();
        browser_clock_stop();
        return status;
    }

    g_clock_now_ms = browser_time_ms();
    clock_port.now_ms = browser_clock_now_ms;
    clock_port.arm_wakeup = NULL;
    clock_port.cancel_wakeup = NULL;
    clock_port.context = &g_clock_now_ms;
    status = os_clock_port_set(&clock_port);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_clock_port_set", status);
        os_shutdown();
        browser_clock_stop();
        return status;
    }

    status = browser_gpio_start(fresh);
    if (status == OS_STATUS_OK)
    {
        status = browser_stores_start();
    }
    if (status == OS_STATUS_OK)
    {
        status = os_output_port_set(&g_browser_output_port);
    }
    if (status == OS_STATUS_OK)
    {
        status = os_display_port_set(&g_browser_display_port);
    }
    if (status == OS_STATUS_OK)
    {
        status = os_i2c_port_set(&g_browser_i2c_port);
    }
    if (status == OS_STATUS_OK)
    {
        status = os_spi_port_set(&g_browser_spi_port);
    }
    if (status == OS_STATUS_OK)
    {
        os_bus_trace_set(browser_bus_trace, NULL);
    }
    if (status != OS_STATUS_OK)
    {
        browser_set_error("browser_runtime_init", status);
        os_shutdown();
        browser_clock_stop();
        return status;
    }

    g_runtime_initialized = 1;
    g_asleep = 0;
    g_last_budget_time_ms = g_clock_now_ms;
    g_fuel_budget = 0.0;
    g_scheduled_slice_count = 0U;
    browser_trace_reset();
    return OS_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE
int browser_runtime_init(void)
{
    if (g_runtime_initialized)
    {
        return (int)OS_STATUS_OK;
    }
    browser_clear_error();
    return (int)browser_kernel_start(1);
}

/* ---------------------------------------------------------------------------
 * Sleep: the whole system saved to the page, the kernel shut down, and
 * restored into a fresh kernel when the board wakes (docs/decisions.md, 1).
 * ------------------------------------------------------------------------ */

EM_JS(void, browser_system_reset_js, (void), {
    Module.savedSystem = [];
});

EM_JS(void, browser_system_append_js, (const void* data, uint32_t size), {
    Module.savedSystem.push(HEAPU8.slice(data, data + size));
});

/* Reads the next bytes of Module.savedSystem (a Uint8Array, set by the page). */
EM_JS(void, browser_system_rewind_js, (void), {
    Module.savedSystemAt = 0;
});

EM_JS(void, browser_system_drop_js, (void), {
    Module.savedSystem = null;
});

EM_JS(int, browser_system_take_js, (void* data, uint32_t size), {
    const stream = Module.savedSystem;
    const at = Module.savedSystemAt || 0;
    if (!(stream instanceof Uint8Array) || at + size > stream.length) return 1;
    HEAPU8.set(stream.subarray(at, at + size), data);
    Module.savedSystemAt = at + size;
    return 0;
});

static OsStatus browser_system_write(void* context, const void* data, uint32_t size)
{
    uint32_t* total = (uint32_t*)context;
    browser_system_append_js(data, size);
    *total += size;
    return OS_STATUS_OK;
}

static OsStatus browser_system_read(void* context, void* data, uint32_t size)
{
    (void)context;
    return browser_system_take_js(data, size) == 0 ? OS_STATUS_OK : OS_STATUS_ERROR;
}

/* The page starts programs by path only, so there is no host module to find. */
static OsStatus browser_system_find(void* context, const char* task_name, const uint8_t** out_bytes,
                                    uint32_t* out_size)
{
    (void)context;
    (void)task_name;
    (void)out_bytes;
    (void)out_size;
    return OS_STATUS_TASK_NOT_FOUND;
}

/*
 * Save the whole system into Module.savedSystem (a list of chunks) and shut
 * the kernel down. out: [0] bytes saved, [1] milliseconds to the next
 * deadline (0xffffffff: none), [2] wake pins, then up to four pairs of pin
 * and edges. The board's parts, displays and pins keep their state.
 */
EMSCRIPTEN_KEEPALIVE
int browser_system_sleep(uint32_t* out)
{
    OsGpioWake wake[4];
    uint32_t total = 0U;
    uint32_t pins;
    uint32_t index;
    OsStatus status;

    if (!g_runtime_initialized)
    {
        browser_set_error("browser_system_sleep", OS_STATUS_ERROR);
        return (int)OS_STATUS_ERROR;
    }
    out[1] = os_get_next_wakeup_ms();
    pins = os_gpio_wake_pins(wake, 4U);
    browser_system_reset_js();
    status = os_system_save(browser_system_write, &total);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_system_save", status);
        browser_system_reset_js();
        return (int)status;
    }
    out[0] = total;
    out[2] = pins < 4U ? pins : 4U;
    for (index = 0U; index < out[2]; ++index)
    {
        out[3U + index * 2U] = wake[index].pin;
        out[4U + index * 2U] = wake[index].edges;
    }
    os_shutdown();
    browser_clock_stop();
    g_runtime_initialized = 0;
    g_asleep = 1;
    return (int)OS_STATUS_OK;
}

/*
 * Wake, first half: a fresh kernel with its ports, the parts as they were.
 * The page then registers its device profile again (the kernel's side of
 * it only) and calls browser_system_restore.
 */
EMSCRIPTEN_KEEPALIVE
int browser_system_boot(void)
{
    browser_clear_error();
    return (int)browser_kernel_start(0);
}

/*
 * Wake, second half: the system from Module.savedSystem (a Uint8Array) with
 * the time slept, then the edge that woke the board (pin 0xffffffff: none).
 * The page's records follow the tasks by id. On failure the kernel is left
 * fresh and empty.
 */
EMSCRIPTEN_KEEPALIVE
int browser_system_restore(uint32_t slept_ms, uint32_t wake_pin, uint32_t wake_edge)
{
    uint32_t ids[BROWSER_MAX_TASKS];
    uint32_t count;
    uint32_t index;
    OsStatus status;
    BrowserTaskRecord** link = &g_task_records;

    browser_system_rewind_js();
    status = os_system_restore(browser_system_read, NULL, browser_system_find, NULL, slept_ms);
    browser_system_drop_js();
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_system_restore", status);
        browser_free_all_records();
        return (int)status;
    }

    /* Handles are new; ids are those the tasks had. */
    while (*link != NULL)
    {
        BrowserTaskRecord* record = *link;
        record->task = os_task_find_by_id(record->task_id);
        if (record->task == NULL)
        {
            *link = record->next;
            free(record);
            continue;
        }
        record->observed_run_count = os_task_get_run_count(record->task);
        link = &record->next;
    }
    /* After a reload the page has no records yet: one for every task there is. */
    count = os_task_get_id_list(ids, BROWSER_MAX_TASKS);
    for (index = 0U; index < count; ++index)
    {
        BrowserTaskRecord* record;
        if (browser_find_record(ids[index]) != NULL)
        {
            continue;
        }
        record = (BrowserTaskRecord*)calloc(1U, sizeof(BrowserTaskRecord));
        if (record == NULL)
        {
            break;
        }
        record->task_id = ids[index];
        record->task = os_task_find_by_id(ids[index]);
        record->observed_run_count = os_task_get_run_count(record->task);
        record->next = g_task_records;
        g_task_records = record;
    }
    if (wake_pin != 0xffffffffU)
    {
        os_gpio_edge(wake_pin, wake_edge);
    }
    return (int)OS_STATUS_OK;
}

/*
 * The board's parts, which keep power through a sleep: the pins as the
 * board sees them, the displays' pictures and brightness, the chips with
 * their registers and pictures. The page keeps them with a saved system so
 * a sleep survives a reload; the parts must be those of the same profile.
 */
#define BROWSER_BOARD_MAGIC 0x31425357U /* "WSB1" */

static uint32_t browser_board_walk(uint8_t* out, const uint8_t* in, uint32_t size)
{
    uint32_t at = 0U;
    uint32_t index;
    int ok = 1;
    uint32_t magic = BROWSER_BOARD_MAGIC;

#define BROWSER_BOARD_BYTES(pointer, length)                                   \
    do                                                                         \
    {                                                                          \
        if (out != NULL)                                                       \
        {                                                                      \
            memcpy(out + at, (pointer), (length));                             \
        }                                                                      \
        else if (in != NULL)                                                   \
        {                                                                      \
            ok = ok && at + (length) <= size;                                  \
            if (ok)                                                            \
            {                                                                  \
                memcpy((pointer), in + at, (length));                          \
            }                                                                  \
        }                                                                      \
        at += (length);                                                        \
    } while (0)

    BROWSER_BOARD_BYTES(&magic, sizeof(magic));
    if (in != NULL && (!ok || magic != BROWSER_BOARD_MAGIC))
    {
        return 0U;
    }
    BROWSER_BOARD_BYTES(&g_board, sizeof(g_board));
    for (index = 0U; index < BROWSER_DISPLAYS && ok; ++index)
    {
        BrowserDisplay* display = &g_displays[index];
        uint32_t pixels = display->rgba != NULL ? display->width * display->height * 4U : 0U;
        BROWSER_BOARD_BYTES(&display->brightness, sizeof(display->brightness));
        if (pixels != 0U)
        {
            BROWSER_BOARD_BYTES(display->rgba, pixels);
            display->dirty = 1U;
        }
    }
    for (index = 0U; index < BROWSER_CHIPS && ok; ++index)
    {
        BrowserChip* chip = &g_chips[index];
        if (chip->type == BROWSER_CHIP_LM75)
        {
            BROWSER_BOARD_BYTES(&chip->as.lm75, sizeof(chip->as.lm75));
        }
        else if (chip->type == BROWSER_CHIP_GC9A01)
        {
            /* The controller's state, then its picture; the picture's buffer stays where it is. */
            BrowserGc9a01 copy = chip->as.gc9a01;
            BrowserDisplay* screen = &chip->as.gc9a01.screen;
            uint32_t pixels = screen->rgba != NULL ? screen->width * screen->height * 4U : 0U;
            BROWSER_BOARD_BYTES(&copy, offsetof(BrowserGc9a01, screen));
            if (in != NULL && ok)
            {
                memcpy(&chip->as.gc9a01, &copy, offsetof(BrowserGc9a01, screen));
            }
            BROWSER_BOARD_BYTES(&screen->brightness, sizeof(screen->brightness));
            if (pixels != 0U)
            {
                BROWSER_BOARD_BYTES(screen->rgba, pixels);
                screen->dirty = 1U;
            }
        }
    }
#undef BROWSER_BOARD_BYTES
    return ok ? at : 0U;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_board_state_size(void)
{
    return browser_board_walk(NULL, NULL, 0U);
}

EMSCRIPTEN_KEEPALIVE
void browser_board_state_write(uint8_t* out)
{
    (void)browser_board_walk(out, NULL, 0U);
}

/* 0 when it fits the board's parts; else the parts are left as they may be and the page starts afresh. */
EMSCRIPTEN_KEEPALIVE
int browser_board_state_read(const uint8_t* in, uint32_t size)
{
    return browser_board_walk(NULL, in, size) == size ? (int)OS_STATUS_OK : (int)OS_STATUS_INVALID_ARGUMENT;
}

/* Which runtime build a saved system came from: one from another build is not woken. */
EMSCRIPTEN_KEEPALIVE
const char* browser_build_id(void)
{
    return __DATE__ " " __TIME__;
}

/*
 * The page reloaded while the device slept: the kernel it just started
 * goes down again, and the device sleeps on until something wakes it.
 */
EMSCRIPTEN_KEEPALIVE
void browser_system_power_down(void)
{
    if (g_runtime_initialized)
    {
        os_shutdown();
        browser_clock_stop();
        g_runtime_initialized = 0;
    }
    g_asleep = 1;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_system_is_asleep(void)
{
    return (uint32_t)g_asleep;
}

/*
 * The chip (docs/decisions.md, 2), before the first program starts: its
 * heap regions in bytes (none: the browser's heap), the frames of RAM for
 * programs, and its page store: kind 0 none, 1 in memory, 2 with delays
 * (write_us and read_us a frame), with slots. The kernel starts again on it.
 */
EMSCRIPTEN_KEEPALIVE
int browser_chip_set(const uint32_t* regions, uint32_t region_count, uint32_t frames, uint32_t store_kind,
                     uint32_t slots, uint32_t write_us, uint32_t read_us, uint32_t priority)
{
    if (g_runtime_initialized)
    {
        os_shutdown();
        browser_clock_stop();
        g_runtime_initialized = 0;
    }
    browser_free_all_records();
    if (chip_heap_set(regions, region_count) != 0)
    {
        browser_set_error("browser_chip_set", OS_STATUS_OUT_OF_MEMORY);
        return (int)OS_STATUS_OUT_OF_MEMORY;
    }
    g_files_on_card = store_kind == 2U;
    g_store_count = store_kind != 0U ? 1U : 0U;
    browser_store_make(&g_stores[0], 0U, slots, frames, store_kind == 2U ? write_us : 0U,
                       store_kind == 2U ? read_us : 0U, priority);
    browser_clear_error();
    return (int)browser_kernel_start(1);
}

/* One more store of the chip, after browser_chip_set: slots only, with its delays and priority. */
EMSCRIPTEN_KEEPALIVE
int browser_chip_add_store(uint32_t slots, uint32_t write_us, uint32_t read_us, uint32_t priority)
{
    OsStatus status;
    if (g_store_count == 0U || g_store_count == BROWSER_STORES)
    {
        browser_set_error("browser_chip_add_store", OS_STATUS_LIMIT_REACHED);
        return (int)OS_STATUS_LIMIT_REACHED;
    }
    browser_store_make(&g_stores[g_store_count], g_store_count, slots, 0U, write_us, read_us, priority);
    status = os_page_store_add(&g_stores[g_store_count].store, priority);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_page_store_add", status);
        return (int)status;
    }
    ++g_store_count;
    return (int)OS_STATUS_OK;
}

/* A store of the chip: [priority, slots, used, frames written, frames read]. */
EMSCRIPTEN_KEEPALIVE
int browser_chip_store_stats(uint32_t index, uint32_t* out)
{
    OsPageStoreStats stats;
    OsStatus status = index < g_store_count ? os_page_get_store_stats(&g_stores[index].store, &stats)
                                            : OS_STATUS_INVALID_ARGUMENT;
    if (status != OS_STATUS_OK)
    {
        return (int)status;
    }
    out[0] = stats.priority;
    out[1] = stats.slots;
    out[2] = stats.used_slots;
    out[3] = stats.stores;
    out[4] = stats.loads;
    return (int)OS_STATUS_OK;
}

/* The chip's heap, region by region: [free, largest free block, size] each; returns how many regions. */
EMSCRIPTEN_KEEPALIVE
uint32_t browser_chip_heap_stats(uint32_t* out, uint32_t max_regions)
{
    return chip_heap_stats(out, max_regions);
}

/* Paging across all programs: frames in RAM, the budget, frames stored, writes and reads so far. */
EMSCRIPTEN_KEEPALIVE
int browser_runtime_get_page_stats(uint32_t* out)
{
    OsPageStats stats;
    OsStatus status = os_page_get_stats(&stats);

    if (status != OS_STATUS_OK)
    {
        return (int)status;
    }
    out[0] = stats.ram_frames;
    out[1] = g_store_count != 0U ? g_stores[0].store.ram_frames : 0U;
    out[2] = stats.stored_frames;
    out[3] = stats.stores;
    out[4] = stats.loads;
    return (int)OS_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE
int browser_gpio_add_pin(const char* name, uint32_t pin, uint32_t capabilities, uint32_t options)
{
    OsStatus status = pin < BROWSER_GPIO_PINS ? os_gpio_add_pin(name, pin, capabilities, options)
                                              : OS_STATUS_INVALID_ARGUMENT;
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_gpio_add_pin", status);
    }
    return (int)status;
}

/*
 * A display of the device profile; lit is the color of a monochrome
 * panel's pixels (0xRRGGBB).
 */
EMSCRIPTEN_KEEPALIVE
int browser_display_add(const char* name, uint32_t number, uint32_t width, uint32_t height, uint32_t shape,
                        uint32_t format, uint32_t formats, uint32_t dpi, uint32_t brightness, uint32_t lit)
{
    OsDisplayInfo info;
    BrowserDisplay* display = number < BROWSER_DISPLAYS ? &g_displays[number] : NULL;
    OsStatus status;

    if (display == NULL || width == 0U || height == 0U || width > 1024U || height > 1024U)
    {
        browser_set_error("browser_display_add", OS_STATUS_INVALID_ARGUMENT);
        return (int)OS_STATUS_INVALID_ARGUMENT;
    }
    memset(&info, 0, sizeof(info));
    info.width = (uint16_t)width;
    info.height = (uint16_t)height;
    info.shape = (uint8_t)shape;
    info.format = (uint8_t)format;
    info.formats = formats;
    info.dpi = (uint16_t)dpi;
    info.has_brightness = 1U;
    info.brightness = (uint8_t)brightness;
    /* The panel keeps power through a sleep, and so its picture (docs/decisions.md, 1). */
    info.keeps_image = 1U;
    status = os_display_add(name, number, &info);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_display_add", status);
        return (int)status;
    }
    if (display->rgba != NULL && display->width == width && display->height == height)
    {
        /* Registered again after a sleep: the picture stays. */
        return (int)OS_STATUS_OK;
    }
    free(display->rgba);
    display->rgba = (uint8_t*)calloc((size_t)width * height, 4U);
    if (display->rgba == NULL)
    {
        return (int)OS_STATUS_OUT_OF_MEMORY;
    }
    display->width = width;
    display->height = height;
    display->lit[0] = (uint8_t)(lit >> 16U);
    display->lit[1] = (uint8_t)(lit >> 8U);
    display->lit[2] = (uint8_t)lit;
    display->brightness = (uint8_t)brightness;
    display->dirty = 1U;
    {
        /* Opaque black until a program draws. */
        uint32_t index;
        for (index = 0U; index < width * height; ++index)
        {
            display->rgba[index * 4U + 3U] = 255U;
        }
    }
    return (int)OS_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* browser_display_framebuffer(uint32_t number)
{
    return number < BROWSER_DISPLAYS ? g_displays[number].rgba : NULL;
}

/* Whether the framebuffer changed since the last call. */
EMSCRIPTEN_KEEPALIVE
uint32_t browser_display_take_dirty(uint32_t number)
{
    uint32_t dirty;

    if (number >= BROWSER_DISPLAYS)
    {
        return 0U;
    }
    dirty = g_displays[number].dirty;
    g_displays[number].dirty = 0U;
    return dirty;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_display_get_brightness(uint32_t number)
{
    return number < BROWSER_DISPLAYS ? g_displays[number].brightness : 0U;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_display_get_owner(uint32_t number)
{
    return os_display_get_owner(number);
}

/* An input device of the device profile; timings in milliseconds. */
EMSCRIPTEN_KEEPALIVE
int browser_input_add(const char* name, uint32_t number, uint32_t kind, uint32_t width, uint32_t height,
                      uint32_t steps_per_turn, uint32_t long_press_ms, uint32_t repeat_delay_ms,
                      uint32_t repeat_interval_ms)
{
    OsInputInfo info;
    OsStatus status;

    memset(&info, 0, sizeof(info));
    info.kind = (uint8_t)kind;
    info.width = (uint16_t)width;
    info.height = (uint16_t)height;
    info.steps_per_turn = (uint16_t)steps_per_turn;
    info.long_press_ms = (uint16_t)long_press_ms;
    info.repeat_delay_ms = (uint16_t)repeat_delay_ms;
    info.repeat_interval_ms = (uint16_t)repeat_interval_ms;
    status = os_input_add(name, number, &info);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_input_add", status);
    }
    return (int)status;
}

EMSCRIPTEN_KEEPALIVE
int browser_input_key(uint32_t number, uint32_t code, uint32_t down)
{
    return (int)os_input_key(number, code, down ? 1U : 0U);
}

EMSCRIPTEN_KEEPALIVE
int browser_input_rotate(uint32_t number, uint32_t code, int32_t steps)
{
    return (int)os_input_rotate(number, code, steps);
}

EMSCRIPTEN_KEEPALIVE
int browser_input_touch(uint32_t number, uint32_t contact, uint32_t phase, uint32_t x, uint32_t y)
{
    return (int)os_input_touch(number, contact, phase, x, y);
}

EMSCRIPTEN_KEEPALIVE
int browser_input_text(uint32_t number, uint32_t code_point)
{
    return (int)os_input_text(number, code_point);
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_input_get_owner(uint32_t number)
{
    return os_input_get_owner(number);
}

EMSCRIPTEN_KEEPALIVE
int browser_i2c_add_bus(const char* name, uint32_t bus, uint32_t frequency_hz)
{
    OsStatus status = os_i2c_add_bus(name, bus, frequency_hz);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_i2c_add_bus", status);
    }
    return (int)status;
}

EMSCRIPTEN_KEEPALIVE
int browser_spi_add_bus(const char* name, uint32_t bus, uint32_t max_hz)
{
    OsStatus status = os_spi_add_bus(name, bus, max_hz);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_spi_add_bus", status);
    }
    return (int)status;
}

static BrowserChip* browser_chip_slot(void)
{
    uint32_t index;
    for (index = 0U; index < BROWSER_CHIPS; ++index)
    {
        if (g_chips[index].type == 0U)
        {
            return &g_chips[index];
        }
    }
    return NULL;
}

/* An LM75 at address on I2C bus; returns the chip number, or -1. */
EMSCRIPTEN_KEEPALIVE
int browser_chip_add_lm75(uint32_t bus, uint32_t address, int32_t temperature_milli)
{
    BrowserChip* chip = browser_chip_slot();
    if (chip == NULL)
    {
        return -1;
    }
    memset(chip, 0, sizeof(*chip));
    chip->type = BROWSER_CHIP_LM75;
    chip->bus = bus;
    chip->address = address;
    chip->as.lm75.temperature_milli = temperature_milli;
    chip->as.lm75.registers[2] = 75U << 8U;  /* hysteresis, 75 C */
    chip->as.lm75.registers[3] = 80U << 8U;  /* overtemperature limit, 80 C */
    return (int)(chip - g_chips);
}

EMSCRIPTEN_KEEPALIVE
void browser_chip_set_temperature(uint32_t chip, int32_t temperature_milli)
{
    if (chip < BROWSER_CHIPS && g_chips[chip].type == BROWSER_CHIP_LM75)
    {
        g_chips[chip].as.lm75.temperature_milli = temperature_milli;
    }
}

/* A GC9A01 on SPI bus with chip select cs_pin and data/command dc_pin; returns the chip number, or -1. */
EMSCRIPTEN_KEEPALIVE
int browser_chip_add_gc9a01(uint32_t bus, uint32_t cs_pin, uint32_t dc_pin, uint32_t width, uint32_t height)
{
    BrowserChip* chip = browser_chip_slot();
    uint32_t index;
    if (chip == NULL || cs_pin >= BROWSER_GPIO_PINS || dc_pin >= BROWSER_GPIO_PINS)
    {
        return -1;
    }
    memset(chip, 0, sizeof(*chip));
    chip->as.gc9a01.screen.rgba = (uint8_t*)calloc((size_t)width * height, 4U);
    if (chip->as.gc9a01.screen.rgba == NULL)
    {
        return -1;
    }
    for (index = 0U; index < width * height; ++index)
    {
        chip->as.gc9a01.screen.rgba[index * 4U + 3U] = 255U;
    }
    chip->type = BROWSER_CHIP_GC9A01;
    chip->bus = bus;
    chip->address = cs_pin;
    chip->as.gc9a01.dc_pin = dc_pin;
    chip->as.gc9a01.screen.width = width;
    chip->as.gc9a01.screen.height = height;
    chip->as.gc9a01.x1 = width - 1U;
    chip->as.gc9a01.y1 = height - 1U;
    chip->as.gc9a01.screen.dirty = 1U;
    return (int)(chip - g_chips);
}

static BrowserGc9a01* browser_panel(uint32_t chip)
{
    return chip < BROWSER_CHIPS && g_chips[chip].type == BROWSER_CHIP_GC9A01 ? &g_chips[chip].as.gc9a01 : NULL;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* browser_chip_framebuffer(uint32_t chip)
{
    BrowserGc9a01* panel = browser_panel(chip);
    return panel != NULL ? panel->screen.rgba : NULL;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_chip_take_dirty(uint32_t chip)
{
    BrowserGc9a01* panel = browser_panel(chip);
    uint32_t dirty = panel != NULL ? panel->screen.dirty : 0U;
    if (panel != NULL)
    {
        panel->screen.dirty = 0U;
    }
    return dirty;
}

/* Whether the panel shows its memory: awake and switched on. */
EMSCRIPTEN_KEEPALIVE
uint32_t browser_chip_is_showing(uint32_t chip)
{
    BrowserGc9a01* panel = browser_panel(chip);
    return panel != NULL && panel->on && panel->awake;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_bus_get_latest_sequence(void)
{
    return g_bus_next_sequence - 1U;
}

/* The event with sequence number sequence, or NULL when it is gone or not there yet. */
EMSCRIPTEN_KEEPALIVE
const BrowserBusEvent* browser_bus_get_event(uint32_t sequence)
{
    if (sequence == 0U || sequence >= g_bus_next_sequence || g_bus_next_sequence - sequence > BROWSER_BUS_EVENTS)
    {
        return NULL;
    }
    return &g_bus_events[(sequence - 1U) % BROWSER_BUS_EVENTS];
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_bus_event_size(void)
{
    return (uint32_t)sizeof(BrowserBusEvent);
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_gpio_get_owner(uint32_t pin)
{
    return os_gpio_get_owner(pin);
}

/* The level a part on the page sees on a pin. */
EMSCRIPTEN_KEEPALIVE
uint32_t browser_gpio_get_level(uint32_t pin)
{
    return pin < BROWSER_GPIO_PINS ? browser_gpio_level(pin) : 0U;
}

/* A part pulls a pin to ground or lets go; the change is an edge. */
EMSCRIPTEN_KEEPALIVE
void browser_gpio_ground(uint32_t pin, uint32_t grounded)
{
    uint8_t before = 0U;
    uint8_t after = 0U;

    if (pin >= BROWSER_GPIO_PINS)
    {
        return;
    }
    before = browser_gpio_level(pin);
    g_board.grounded[pin] = grounded ? 1U : 0U;
    after = browser_gpio_level(pin);
    if (before != after && (g_board.flags[pin] & (OS_GPIO_EDGE_RISING | OS_GPIO_EDGE_FALLING)) != 0U)
    {
        os_gpio_edge(pin, after ? OS_GPIO_EDGE_RISING : OS_GPIO_EDGE_FALLING);
    }
}

EMSCRIPTEN_KEEPALIVE
void browser_runtime_shutdown(void)
{
    if (g_runtime_initialized)
    {
        os_shutdown();
    }

    browser_free_all_records();
    browser_display_free_all();
    browser_chips_free_all();
    browser_clock_stop();
    g_clock_now_ms = 0U;
    g_last_budget_time_ms = 0U;
    g_fuel_budget = 0.0;
    g_scheduled_slice_count = 0U;
    browser_trace_reset();
    browser_clear_error();
    g_runtime_initialized = 0;
}

/*
 * Start the program at an absolute VFS path as a process, like an executable
 * on a board. A program from the browser file store runs without a copy.
 */
EMSCRIPTEN_KEEPALIVE
uint32_t browser_task_spawn(const char* path, uint32_t priority)
{
    BrowserTaskRecord* record;
    OsStatus status;

    if (!g_runtime_initialized && browser_runtime_init() != (int)OS_STATUS_OK)
    {
        return 0U;
    }

    if (path == NULL || path[0] == '\0')
    {
        browser_set_error("browser_task_spawn", OS_STATUS_INVALID_ARGUMENT);
        return 0U;
    }

    record = (BrowserTaskRecord*)calloc(1U, sizeof(BrowserTaskRecord));
    if (record == NULL)
    {
        browser_set_error("browser_task_spawn", OS_STATUS_OUT_OF_MEMORY);
        return 0U;
    }

    status = os_task_spawn_path(&record->task, path, NULL, 0U, priority, 0U);
    if (status != OS_STATUS_OK || record->task == NULL)
    {
        browser_set_error("os_task_spawn_path", status);
        free(record);
        return 0U;
    }

    record->task_id = os_task_get_id(record->task);
    record->observed_run_count = os_task_get_run_count(record->task);
    record->next = g_task_records;
    g_task_records = record;
    browser_clear_error();
    return record->task_id;
}

EMSCRIPTEN_KEEPALIVE
int browser_task_delete(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    OsStatus status;

    if (record == NULL)
    {
        browser_set_error("browser_task_delete", OS_STATUS_TASK_NOT_FOUND);
        return (int)OS_STATUS_TASK_NOT_FOUND;
    }

    status = os_task_delete(record->task);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_task_delete", status);
        return (int)status;
    }

    browser_remove_record(record);
    browser_clear_error();
    return (int)OS_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE
int browser_task_suspend(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    OsStatus status;

    if (record == NULL)
    {
        return (int)OS_STATUS_TASK_NOT_FOUND;
    }

    status = os_task_suspend(record->task);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_task_suspend", status);
    }
    return (int)status;
}

EMSCRIPTEN_KEEPALIVE
int browser_task_resume(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    OsStatus status;

    if (record == NULL)
    {
        return (int)OS_STATUS_TASK_NOT_FOUND;
    }

    status = os_task_resume(record->task);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_task_resume", status);
    }
    return (int)status;
}

EMSCRIPTEN_KEEPALIVE
int browser_task_set_priority(uint32_t task_id, uint32_t priority)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    OsStatus status;

    if (record == NULL)
    {
        return (int)OS_STATUS_TASK_NOT_FOUND;
    }

    status = os_task_set_priority(record->task, priority);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_task_set_priority", status);
    }
    return (int)status;
}

EMSCRIPTEN_KEEPALIVE
int browser_runtime_step(uint32_t now_ms, uint32_t max_slices)
{
    uint32_t slice;
    OsStatus status;

    if (g_asleep)
    {
        return (int)OS_STATUS_OK;
    }
    if (!g_runtime_initialized)
    {
        status = (OsStatus)browser_runtime_init();
        if (status != OS_STATUS_OK)
        {
            return (int)status;
        }
    }

    g_clock_now_ms = now_ms;
    status = os_clock_poll();
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_clock_poll", status);
        return (int)status;
    }

    if (max_slices > BROWSER_MAX_SLICES_PER_FRAME)
    {
        max_slices = BROWSER_MAX_SLICES_PER_FRAME;
    }

    for (slice = 0U; slice < max_slices; ++slice)
    {
        double slice_started_at_ms;
        double slice_finished_at_ms;

        (void)browser_wire_poll();
        slice_started_at_ms = browser_elapsed_now_ms();
        /* The chip is still waiting for the card: no slice runs until that time has passed. */
        if (slice_started_at_ms < g_page_owed_until_ms)
        {
            break;
        }
        status = os_schedule();
        slice_finished_at_ms = browser_elapsed_now_ms();
        browser_trace_capture_slice(slice_started_at_ms, slice_finished_at_ms);
        if (status == OS_STATUS_NO_READY_TASKS)
        {
            /* Everyone waits; a transfer about to end is worth waiting for within this frame. */
            double wait_ms = browser_wire_poll();
            if (wait_ms < 0.0 || wait_ms > BROWSER_WIRE_SPIN_MS)
            {
                return (int)OS_STATUS_OK;
            }
            while (browser_elapsed_now_ms() < slice_finished_at_ms + wait_ms)
            {
            }
            continue;
        }
        if (status != OS_STATUS_OK)
        {
            browser_set_error("os_schedule", status);
            return (int)status;
        }
        ++g_scheduled_slice_count;
    }

    return (int)OS_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE
void browser_runtime_set_slices_per_frame(uint32_t slice_count)
{
    uint32_t fuel_per_ms;

    if (slice_count == 0U)
    {
        slice_count = 1U;
    }
    if (slice_count > BROWSER_MAX_SLICES_PER_FRAME)
    {
        slice_count = BROWSER_MAX_SLICES_PER_FRAME;
    }
    fuel_per_ms = slice_count * BROWSER_FUEL_PER_SLICE * 60U / 1000U;
    if (fuel_per_ms > BROWSER_MAX_FUEL_PER_MS)
    {
        fuel_per_ms = BROWSER_MAX_FUEL_PER_MS;
    }
    g_fuel_per_ms = fuel_per_ms;
    g_fuel_budget = 0.0;
    g_last_budget_time_ms = browser_time_ms();
}

EMSCRIPTEN_KEEPALIVE
void browser_runtime_set_fuel_per_ms(uint32_t fuel_per_ms)
{
    if (fuel_per_ms > BROWSER_MAX_FUEL_PER_MS)
    {
        fuel_per_ms = BROWSER_MAX_FUEL_PER_MS;
    }

    g_fuel_per_ms = fuel_per_ms;
    g_fuel_budget = 0.0;
    g_last_budget_time_ms = browser_time_ms();
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_runtime_get_fuel_per_ms(void)
{
    return g_fuel_per_ms;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_runtime_get_fuel_per_slice(void)
{
    return BROWSER_FUEL_PER_SLICE;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_runtime_get_scheduled_slice_count(void)
{
    return g_scheduled_slice_count;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_trace_get_oldest_sequence(void)
{
    uint32_t latest_sequence;

    if (g_trace_event_count == 0U)
    {
        return 0U;
    }

    latest_sequence = g_trace_next_sequence - 1U;
    return latest_sequence - g_trace_event_count + 1U;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_trace_get_latest_sequence(void)
{
    return g_trace_event_count == 0U ? 0U : g_trace_next_sequence - 1U;
}

EMSCRIPTEN_KEEPALIVE
double browser_trace_get_clock_ms(void)
{
    return browser_elapsed_now_ms();
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_trace_read(
    uint32_t first_sequence,
    uint32_t max_events,
    uint32_t* out_task_ids,
    double* out_started_at_ms,
    double* out_duration_ms
)
{
    uint32_t oldest_sequence = browser_trace_get_oldest_sequence();
    uint32_t latest_sequence = browser_trace_get_latest_sequence();
    uint32_t copied = 0U;
    uint32_t sequence;

    if (oldest_sequence == 0U || max_events == 0U ||
        out_task_ids == NULL || out_started_at_ms == NULL || out_duration_ms == NULL)
    {
        return 0U;
    }

    if (first_sequence < oldest_sequence)
    {
        first_sequence = oldest_sequence;
    }

    for (sequence = first_sequence;
         sequence <= latest_sequence && copied < max_events;
         ++sequence)
    {
        const BrowserTraceEvent* event = browser_trace_find(sequence);

        if (event == NULL)
        {
            break;
        }

        out_task_ids[copied] = event->task_id;
        out_started_at_ms[copied] = event->started_at_ms;
        out_duration_ms[copied] = event->duration_ms;
        ++copied;
    }

    return copied;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_task_get_state(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    return record != NULL ? (uint32_t)os_task_get_state(record->task) : (uint32_t)OS_TASK_DEAD;
}

/*
 * A task's memory, as os_task_get_memory_usage reports it, into ten u32
 * values at out: stack, stack peak, linear memory, code, interpreter,
 * interpreter peak, image, swap, kernel, total.
 */
EMSCRIPTEN_KEEPALIVE
int browser_task_get_memory_usage(uint32_t task_id, uint32_t* out)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    OsTaskMemoryUsage usage;
    OsStatus status = OS_STATUS_TASK_NOT_FOUND;

    if (record != NULL)
    {
        status = os_task_get_memory_usage(record->task, &usage);
    }
    if (status != OS_STATUS_OK)
    {
        return (int)status;
    }
    out[0] = usage.stack_bytes;
    out[1] = usage.stack_peak_bytes;
    out[2] = usage.linear_memory_bytes;
    out[3] = usage.code_bytes;
    out[4] = usage.interpreter_bytes;
    out[5] = usage.interpreter_peak_bytes;
    out[6] = usage.image_bytes;
    out[7] = usage.swap_bytes;
    out[8] = usage.kernel_bytes;
    out[9] = usage.total_bytes;
    out[10] = usage.resident_memory_bytes;
    out[11] = usage.stored_memory_bytes;
    out[12] = usage.block_memory_bytes;
    return (int)OS_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE
const char* browser_task_get_app_name(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    return record != NULL ? os_task_get_app_name(record->task) : NULL;
}

EMSCRIPTEN_KEEPALIVE
const char* browser_task_get_error(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    return record != NULL ? os_task_get_error(record->task) : NULL;
}

EMSCRIPTEN_KEEPALIVE
int browser_task_swap_out(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    OsStatus status = record != NULL ? os_task_swap_out(record->task) : OS_STATUS_TASK_NOT_FOUND;
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_task_swap_out", status);
    }
    return (int)status;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_task_is_swapped(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    return record != NULL ? (uint32_t)os_task_is_swapped(record->task) : 0U;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_task_get_priority(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    return record != NULL ? os_task_get_priority(record->task) : 0U;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_task_get_run_count(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    return record != NULL ? os_task_get_run_count(record->task) : 0U;
}

/* A double holds every count of fuel a page session reaches exactly. */
EMSCRIPTEN_KEEPALIVE
double browser_task_get_fuel_used(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    return record != NULL ? (double)os_task_get_fuel_used(record->task) : 0.0;
}

EMSCRIPTEN_KEEPALIVE
double browser_task_get_cpu_ms(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    return record != NULL ? record->cpu_ms : 0.0;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_task_get_exit_reason(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    return record != NULL ? (uint32_t)os_task_get_exit_reason(record->task) : (uint32_t)OS_TASK_EXIT_NONE;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_task_get_exit_code(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    return record != NULL ? os_task_get_exit_code(record->task) : 0U;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_runtime_get_task_count(void)
{
    return os_get_task_count();
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_runtime_get_ready_task_count(void)
{
    return os_get_ready_task_count();
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_runtime_get_waiting_task_count(void)
{
    return os_get_waiting_task_count();
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_runtime_get_timer_count(void)
{
    return os_get_timer_count();
}

EMSCRIPTEN_KEEPALIVE
const char* browser_runtime_get_last_error(void)
{
    return g_error_message;
}

static void browser_main_loop(void)
{
    uint32_t now_ms = browser_time_ms();
    uint32_t elapsed_ms = now_ms - g_last_budget_time_ms;
    uint32_t slice_count;
    const double max_budget =
        (double)BROWSER_MAX_SLICES_PER_FRAME * (double)BROWSER_FUEL_PER_SLICE;

    g_last_budget_time_ms = now_ms;
    if (elapsed_ms > BROWSER_MAX_ELAPSED_BUDGET_MS)
    {
        elapsed_ms = BROWSER_MAX_ELAPSED_BUDGET_MS;
    }

    if (g_fuel_per_ms == 0U)
    {
        g_fuel_budget = 0.0;
        (void)browser_runtime_step(now_ms, 0U);
        return;
    }

    g_fuel_budget += (double)elapsed_ms * (double)g_fuel_per_ms;
    if (g_fuel_budget > max_budget)
    {
        g_fuel_budget = max_budget;
    }

    slice_count = (uint32_t)(g_fuel_budget / (double)BROWSER_FUEL_PER_SLICE);
    if (slice_count > BROWSER_MAX_SLICES_PER_FRAME)
    {
        slice_count = BROWSER_MAX_SLICES_PER_FRAME;
    }
    if (slice_count > 0U)
    {
        g_fuel_budget -= (double)slice_count * (double)BROWSER_FUEL_PER_SLICE;
    }

    (void)browser_runtime_step(now_ms, slice_count);
}

int main(void)
{
    int status = browser_runtime_init();

    if (status != (int)OS_STATUS_OK)
    {
        fprintf(stderr, "%s\n", browser_runtime_get_last_error());
        return status;
    }

    emscripten_set_main_loop(browser_main_loop, 0, 1);
    return 0;
}

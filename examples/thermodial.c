/*
 * A thermometer on two buses: an LM75 on I2C gives the temperature, a round
 * GC9A01 panel on SPI shows it as a disc that grows and warms in color. The
 * panel driver is the program's own: commands while DC is low, parameters
 * and pixels while it is high, as the controller's datasheet describes.
 *
 * Build: clang --target=wasm32-wasip1 --sysroot=<wasi-sysroot> -I<wasm-rtos>/include \
 *        -O2 -o thermodial.wasm thermodial.c
 */
#include <stdio.h>
#include <wasm-rtos.h>

WR_APP_ABI_VERSION();
WR_APP_NAME("Thermo dial");
WR_APP_STACK_SIZE(4096);

#define SIZE 240

static int32_t g_lcd;
static int32_t g_dc;

static void command(uint8_t code, const uint8_t* parameters, uint32_t count)
{
    wr_gpio_set(g_dc, 0);
    wr_spi_write(g_lcd, &code, 1);
    if (count > 0)
    {
        wr_gpio_set(g_dc, 1);
        wr_spi_write(g_lcd, parameters, count);
    }
}

static void panel_init(void)
{
    static const uint8_t pixel_format = 0x05;  /* 16 bits per pixel */
    static const uint8_t address_mode = 0x48;  /* MX | BGR: upright, as these modules are wired */
    command(0x01, 0, 0);                       /* software reset */
    wr_sleep_ms(120);
    command(0x11, 0, 0);                       /* out of sleep */
    wr_sleep_ms(120);
    command(0x3A, &pixel_format, 1);
    command(0x36, &address_mode, 1);
    command(0x21, 0, 0);                       /* inversion on: right colors on this glass */
    command(0x29, 0, 0);                       /* display on */
}

/* Blue at -10 C, through green, to red at 50 C. */
static uint16_t heat_color(int32_t tenths)
{
    int32_t t = (tenths + 100) * 255 / 600;
    uint32_t red, green, blue;
    if (t < 0)
        t = 0;
    if (t > 255)
        t = 255;
    red = t > 128 ? (uint32_t)(t - 128) * 2 : 0;
    blue = t < 128 ? (uint32_t)(128 - t) * 2 : 0;
    green = 255u - red - blue;
    return (uint16_t)(((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3));
}

/* The whole frame row by row: the window is the screen, RAMWR, then 240 rows of pixels. */
static void draw(int32_t tenths)
{
    static uint8_t row[SIZE * 2];
    static const uint8_t window[4] = { 0, 0, 0, SIZE - 1 };
    int32_t radius = 20 + (tenths + 100) * 95 / 600;
    uint16_t color = heat_color(tenths);

    if (radius < 20)
        radius = 20;
    if (radius > 115)
        radius = 115;
    command(0x2A, window, 4);
    command(0x2B, window, 4);
    command(0x2C, 0, 0);
    wr_gpio_set(g_dc, 1);
    for (int32_t y = 0; y < SIZE; ++y)
    {
        for (int32_t x = 0; x < SIZE; ++x)
        {
            int32_t dx = x - SIZE / 2, dy = y - SIZE / 2;
            int32_t d2 = dx * dx + dy * dy;
            uint16_t pixel = d2 < radius * radius ? color : d2 < 118 * 118 && d2 > 112 * 112 ? 0x7BEF : 0x0000;
            row[x * 2] = (uint8_t)(pixel >> 8);  /* the controller takes the high byte first */
            row[x * 2 + 1] = (uint8_t)pixel;
        }
        wr_spi_write(g_lcd, row, sizeof(row));
    }
}

int main(void)
{
    static const uint8_t temperature_register = 0x00;
    int32_t sensor = wr_i2c_open_cstr("i2c0", 0x48);
    int32_t shown = -100000;

    g_lcd = wr_spi_open_cstr("spi0", "lcd-cs", WR_SPI_MODE_0, 40000000);
    g_dc = wr_gpio_open_cstr("lcd-dc", WR_GPIO_OUTPUT);
    if (sensor < 0 || g_lcd < 0 || g_dc < 0)
    {
        printf("needs i2c0 with an LM75 at 0x48, spi0 with lcd-cs and lcd-dc (%d %d %d)\n", (int)sensor, (int)g_lcd,
               (int)g_dc);
        return 1;
    }
    panel_init();
    for (;;)
    {
        uint8_t raw[2];
        int32_t result = wr_i2c_write_read(sensor, &temperature_register, 1, raw, 2);
        if (result == 0)
        {
            /* 1/256 degree, signed, left-aligned. */
            int32_t tenths = (int16_t)((raw[0] << 8) | raw[1]) * 10 / 256;
            if (tenths != shown)
            {
                printf("%d.%d C\n", (int)(tenths / 10), (int)(tenths < 0 ? -tenths % 10 : tenths % 10));
                draw(tenths);
                shown = tenths;
            }
        }
        else
        {
            printf("sensor: error %d\n", (int)-result);
        }
        wr_sleep_ms(500);
    }
}

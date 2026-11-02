/*
 * A watch face that runs on any device profile: it asks the display for its
 * size, shape and pixel format and draws with fills only, so it needs no
 * frame buffer and works on a 1-bit panel too. The bezel turns the hand,
 * the buttons change its color, a long press resets it, a touch leaves a dot.
 *
 * Build: clang --target=wasm32-wasip1 --sysroot=<wasi-sysroot> -I<wasm-rtos>/include \
 *        -O2 -o watchface.wasm watchface.c
 */
#include <stdio.h>
#include <wasm-rtos.h>

WR_APP_ABI_VERSION();
WR_APP_NAME("Watch face");
WR_APP_STACK_SIZE(4096);

static int32_t g_display;
static uint32_t g_width, g_height, g_format;
static int g_round;

/* A color in the display's format; on a 1-bit panel anything but black is lit. */
static uint32_t color(uint32_t rgb)
{
    if (g_format == WR_PIXEL_MONO1)
        return rgb != 0u;
    if (g_format == WR_PIXEL_RGB565)
        return ((rgb >> 8) & 0xF800u) | ((rgb >> 5) & 0x07E0u) | ((rgb >> 3) & 0x001Fu);
    return rgb;
}

static void square(int32_t x, int32_t y, uint32_t size, uint32_t rgb)
{
    if (x < 0 || y < 0 || (uint32_t)x + size > g_width || (uint32_t)y + size > g_height)
        return;
    wr_display_fill(g_display, (uint32_t)x, (uint32_t)y, size, size, g_format, color(rgb));
}

/* sin and cos of step * 15 degrees, times 1000: no floating point needed. */
static const int16_t k_sin[24] = { 0, 259, 500, 707, 866, 966, 1000, 966, 866, 707, 500, 259,
                                   0, -259, -500, -707, -866, -966, -1000, -966, -866, -707, -500, -259 };

static void ray(int position, int32_t from, int32_t to, uint32_t size, uint32_t rgb)
{
    int step = ((position % 24) + 24) % 24;
    int32_t cx = (int32_t)g_width / 2, cy = (int32_t)g_height / 2;
    for (int32_t r = from; r <= to; r += (int32_t)size)
        square(cx + r * k_sin[step] / 1000 - (int32_t)size / 2, cy - r * k_sin[(step + 6) % 24] / 1000 - (int32_t)size / 2,
               size, rgb);
}

static const uint32_t k_colors[4] = { 0xFFB000u, 0x20A433u, 0x9FBDDFu, 0xE7E7E7u };

static void draw(int hand, int previous, int color_index)
{
    int32_t radius = (int32_t)(g_width < g_height ? g_width : g_height) / 2;
    uint32_t dot = radius > 60 ? 6u : 2u;

    if (previous >= 0)
        ray(previous, 0, radius - 16, dot, 0);
    for (int tick = 0; tick < 24; ++tick)
        ray(tick, radius - (tick % 6 == 0 ? 14 : 8), radius - 4, dot / 2 + 1, 0x808080u);
    ray(hand, 0, radius - 16, dot, k_colors[color_index]);
    wr_display_flush(g_display);
}

int main(void)
{
    int32_t handles[4];
    uint32_t count = 0;
    int32_t bezel, buttons, touch, ticker;
    int hand = 0, color_index = 0;
    wr_input_event events[8];

    g_display = wr_display_open_cstr("main");
    if (g_display < 0)
    {
        printf("no display here (%d)\n", (int)g_display);
        return 1;
    }
    g_width = (uint32_t)wr_display_get(g_display, WR_DISPLAY_WIDTH);
    g_height = (uint32_t)wr_display_get(g_display, WR_DISPLAY_HEIGHT);
    g_format = (uint32_t)wr_display_get(g_display, WR_DISPLAY_FORMAT);
    g_round = wr_display_get(g_display, WR_DISPLAY_SHAPE) == (int32_t)WR_DISPLAY_ROUND;
    printf("display %ux%u, %s, format %u\n", (unsigned)g_width, (unsigned)g_height, g_round ? "round" : "rectangular",
           (unsigned)g_format);
    wr_display_fill(g_display, 0, 0, g_width, g_height, g_format, 0);

    /* Whatever this device has; without a bezel the hand follows the seconds. */
    bezel = wr_input_open_cstr("bezel");
    buttons = wr_input_open_cstr("buttons");
    touch = wr_input_open_cstr("touch");
    ticker = wr_timer_create(2500, WR_TIMER_PERIODIC);
    if (bezel > 0)
        handles[count++] = bezel;
    if (buttons > 0)
        handles[count++] = buttons;
    if (touch > 0)
        handles[count++] = touch;
    if (bezel <= 0)
    {
        wr_timer_start(ticker);
        handles[count++] = ticker;
    }
    printf("inputs: bezel %s, buttons %s, touch %s\n", bezel > 0 ? "yes" : "no", buttons > 0 ? "yes" : "no",
           touch > 0 ? "yes" : "no");
    draw(hand, -1, color_index);

    for (;;)
    {
        int32_t ready = wr_wait_any(handles, count, WR_WAIT_FOREVER);
        int previous = hand;
        int32_t got;

        if (ready < 0)
            return 2;
        if (handles[ready] == ticker)
        {
            hand += wr_timer_read(ticker);
            draw(hand, previous, color_index);
            continue;
        }
        got = wr_input_read(handles[ready], events, 8);
        for (int32_t i = 0; i < got; ++i)
        {
            const wr_input_event* e = &events[i];
            if (e->type == WR_EVENT_ROTATE)
                hand += e->value;
            else if (e->type == WR_EVENT_KEY && e->value == WR_KEY_PRESSED)
                color_index = (color_index + (e->code == WR_KEY_BACK ? 3 : 1)) % 4;
            else if (e->type == WR_EVENT_KEY && e->value == WR_KEY_LONG_PRESS)
            {
                printf("long press: reset\n");
                hand = 0;
                color_index = 0;
                wr_display_fill(g_display, 0, 0, g_width, g_height, g_format, 0);
                previous = -1;
            }
            else if (e->type == WR_EVENT_TOUCH && e->value != WR_TOUCH_UP)
                square((int32_t)e->x - 3, (int32_t)e->y - 3, 6, 0x575757u);
            if (e->type == WR_EVENT_KEY || e->type == WR_EVENT_DROPPED)
                printf("event %u code %u value %d\n", (unsigned)e->type, (unsigned)e->code, (int)e->value);
        }
        draw(hand, previous, color_index);
    }
}

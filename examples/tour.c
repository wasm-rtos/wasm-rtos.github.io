/*
 * A tour of what every board has: the program's own file, a computation,
 * paged memory, the LED, a child process and the button. It prints only
 * what must be the same wherever it runs, so its output on an ESP32 and on
 * the page can be compared line by line; timings it checks itself.
 * Arguments: "child" makes it the child it starts.
 *
 * Build: clang --target=wasm32-wasip1 --sysroot=<wasi-sysroot> -I<wasm-rtos>/include \
 *        -O2 -o tour.wasm tour.c
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <wasm-rtos.h>

WR_APP_ABI_VERSION();
WR_APP_NAME("Tour");

#define SELF "/sd/examples/tour.wasm"

static uint64_t now_ms(void)
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000u + (uint64_t)now.tv_nsec / 1000000u;
}

static void wait_until(uint64_t when_ms)
{
    uint64_t now = now_ms();
    if (when_ms > now)
        usleep((useconds_t)((when_ms - now) * 1000u));
}

/* The program's own file: its size and CRC-32. */
static void own_file(void)
{
    FILE* file = fopen(SELF, "rb");
    uint32_t crc = 0xffffffffu;
    long size = 0;
    int byte;

    if (file == NULL)
    {
        printf("file %s: cannot open\n", SELF);
        return;
    }
    while ((byte = fgetc(file)) != EOF)
    {
        crc ^= (uint32_t)byte;
        for (int bit = 0; bit < 8; bit++)
            crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
        size++;
    }
    fclose(file);
    printf("file %s: %ld bytes, crc32 %08x\n", SELF, size, (unsigned)~crc);
}

static void primes(void)
{
    enum { LIMIT = 20000 };
    static uint8_t composite[LIMIT];
    int count = 0;

    for (int n = 2; n < LIMIT; n++)
    {
        if (composite[n])
            continue;
        count++;
        for (int multiple = n * 2; multiple < LIMIT; multiple += n)
            composite[multiple] = 1;
    }
    printf("primes below %d: %d\n", LIMIT, count);
}

/* More memory than the dev board's RAM budget: its frames go to the store and come back. */
static void memory(void)
{
    const uint32_t size = 256u * 1024u;
    uint32_t* words = malloc(size);
    uint32_t bad = 0;

    if (words == NULL)
    {
        printf("memory 256 KB: no memory\n");
        return;
    }
    for (uint32_t i = 0; i < size / 4u; i++)
        words[i] = i * 2654435761u;
    for (int pass = 0; pass < 3; pass++)
        for (uint32_t i = 0; i < size / 4u; i += 97u)
            bad += words[i] != i * 2654435761u;
    free(words);
    printf("memory 256 KB: %s\n", bad ? "MISMATCH" : "ok");
}

/* Ten blinks every 100 ms on the program's clock, within 5%. */
static void led(void)
{
    int32_t pin = wr_gpio_open_cstr("led", WR_GPIO_OUTPUT);
    uint64_t start;
    uint64_t took;
    int levels_ok = 1;

    if (pin < 0)
    {
        printf("led: cannot open (%d)\n", (int)pin);
        return;
    }
    start = now_ms();
    for (int half = 1; half <= 20; half++)
    {
        wr_gpio_set(pin, (uint32_t)(half & 1));
        levels_ok &= wr_gpio_get(pin) == (half & 1);
        wait_until(start + (uint64_t)half * 50u);
    }
    took = now_ms() - start;
    wr_close(pin);
    printf("led: 10 blinks, %s%s\n", took >= 950 && took <= 1050 ? "on time" : "LATE",
           levels_ok ? "" : ", levels wrong");
}

static void child(void)
{
    /* The whole argv, as a shell passes it: the path, then the argument. */
    wr_str args[] = { { SELF, sizeof(SELF) - 1 }, { "child", 5 } };
    int32_t handle = wr_spawn_path_cstr(SELF, args, 2, 0, 0);

    if (handle < 0)
    {
        printf("child: cannot start (%d)\n", (int)handle);
        return;
    }
    printf("child exited with %d\n", (int)wr_wait(handle, WR_WAIT_FOREVER));
    wr_close(handle);
}

/* The button pressed within 10 s, seen as an edge. */
static void button(void)
{
    int32_t pin = wr_gpio_open_cstr("button-a", WR_GPIO_PULL_UP | WR_GPIO_ACTIVE_LOW);

    if (pin < 0)
    {
        printf("button: cannot open (%d)\n", (int)pin);
        return;
    }
    wr_gpio_watch(pin, WR_GPIO_RISING);
    printf("press the button within 10 s\n");
    fflush(stdout);
    printf("button: %s\n", wr_wait_any(&pin, 1, 10000) == 0 && wr_gpio_events(pin) > 0 ? "pressed" : "not pressed");
    wr_close(pin);
}

int main(int argc, char** argv)
{
    if (argc > 1 && strcmp(argv[1], "child") == 0)
        return 42;
    own_file();
    primes();
    memory();
    led();
    child();
    button();
    printf("tour done\n");
    return 0;
}

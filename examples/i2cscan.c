/*
 * Lists the devices on an I2C bus, like i2cdetect: each address gets a
 * transaction without data, and the ones that acknowledge are shown.
 * Arguments: the bus name (default "i2c0").
 *
 * Build: clang --target=wasm32-wasip1 --sysroot=<wasi-sysroot> -I<wasm-rtos>/include \
 *        -O2 -o i2cscan.wasm i2cscan.c
 */
#include <stdio.h>
#include <string.h>
#include <wasm-rtos.h>

WR_APP_ABI_VERSION();
WR_APP_NAME("I2C scan");
WR_APP_STACK_SIZE(4096);

int main(int argc, char** argv)
{
    const char* bus = argc > 1 ? argv[1] : "i2c0";
    int found = 0;

    printf("     0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f\n");
    for (uint32_t row = 0; row < 0x80u; row += 16u)
    {
        printf("%02x:", (unsigned)row);
        for (uint32_t address = row; address < row + 16u; ++address)
        {
            int32_t device;
            int32_t result;
            /* 0x00-0x07 and 0x78-0x7f are reserved by the I2C specification. */
            if (address < 0x08u || address > 0x77u)
            {
                printf("   ");
                continue;
            }
            device = wr_i2c_open(bus, (uint32_t)strlen(bus), address, 0u);
            if (device < 0)
            {
                printf("\ncannot open %s: error %d\n", bus, (int)-device);
                return 1;
            }
            result = wr_i2c_transaction(device, 0, 0u);
            wr_close(device);
            if (result == 0)
            {
                printf(" %02x", (unsigned)address);
                ++found;
            }
            else
            {
                printf(" --");
            }
        }
        printf("\n");
    }
    printf("%d device%s on %s\n", found, found == 1 ? "" : "s", bus);
    return 0;
}

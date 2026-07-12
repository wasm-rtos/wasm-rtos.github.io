/*
 * Browser entry point for wasm-rtos.
 *
 * The Emscripten build must compile this file instead of
 * os/wasm-rtos/hal.c because this translation unit provides the
 * browser-specific HAL implementation.
 */

#include "os/wasm-rtos/os.h"
#include "os/wasm-rtos/hal.h"

#include <emscripten/emscripten.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define BROWSER_DEFAULT_STACK_SIZE (64U * 1024U)
#define BROWSER_DEFAULT_SLICES_PER_FRAME 4U
#define BROWSER_MAX_SLICES_PER_FRAME 64U
#define BROWSER_ERROR_MESSAGE_SIZE 256U

typedef struct BrowserTaskRecord
{
    uint32_t task_id;
    OsTaskHandle task;
    uint8_t* wasm_bytes;
    char* entry_function_name;
    struct BrowserTaskRecord* next;
} BrowserTaskRecord;

static BrowserTaskRecord* g_task_records;
static double g_hal_start_time_ms;
static uint32
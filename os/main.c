/*
 * Browser entry point for wasm-rtos.
 *
 * Build this file with Emscripten together with os/wasm-rtos/os.c and
 * wasm3. Do not compile os/wasm-rtos/hal.c in the browser target because
 * this file provides the browser HAL implementation.
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
static uint32_t g_clock_now_ms;
static uint32_t g_slices_per_frame = BROWSER_DEFAULT_SLICES_PER_FRAME;
static int g_runtime_initialized;
static char g_error_message[BROWSER_ERROR_MESSAGE_SIZE];

static uint32_t browser_clock_now_ms(void* context)
{
    return context != NULL ? *(const uint32_t*)context : 0U;
}

static BrowserTaskRecord* browser_find_record(uint32_t task_id)
{
    BrowserTaskRecord* record = g_task_records;

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
            free(target->entry_function_name);
            free(target->wasm_bytes);
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
        free(record->entry_function_name);
        free(record->wasm_bytes);
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

void hal_init(void)
{
    g_hal_start_time_ms = emscripten_get_now();
}

void hal_shutdown(void)
{
    g_hal_start_time_ms = 0.0;
}

uint32_t hal_get_time_ms(void)
{
    double elapsed_ms;

    if (g_hal_start_time_ms == 0.0)
    {
        return 0U;
    }

    elapsed_ms = emscripten_get_now() - g_hal_start_time_ms;
    if (elapsed_ms <= 0.0)
    {
        return 0U;
    }

    return (uint32_t)elapsed_ms;
}

void hal_panic(const char* message)
{
    fprintf(stderr, "wasm-rtos panic: %s\n", message != NULL ? message : "unknown error");
    abort();
}

EMSCRIPTEN_KEEPALIVE
int browser_runtime_init(void)
{
    OsClockPort clock_port;
    OsStatus status;

    if (g_runtime_initialized)
    {
        return (int)OS_STATUS_OK;
    }

    browser_clear_error();
    hal_init();
    status = os_init();
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_init", status);
        hal_shutdown();
        return (int)status;
    }

    g_clock_now_ms = hal_get_time_ms();
    clock_port.now_ms = browser_clock_now_ms;
    clock_port.arm_wakeup = NULL;
    clock_port.cancel_wakeup = NULL;
    clock_port.context = &g_clock_now_ms;
    status = os_clock_port_set(&clock_port);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_clock_port_set", status);
        os_shutdown();
        hal_shutdown();
        return (int)status;
    }

    g_runtime_initialized = 1;
    return (int)OS_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE
void browser_runtime_shutdown(void)
{
    if (g_runtime_initialized)
    {
        os_shutdown();
    }

    browser_free_all_records();
    hal_shutdown();
    g_clock_now_ms = 0U;
    browser_clear_error();
    g_runtime_initialized = 0;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_task_create(
    const uint8_t* wasm_bytes,
    uint32_t wasm_size,
    const char* entry_function_name,
    const char* task_name,
    uint32_t stack_size,
    uint32_t priority
)
{
    BrowserTaskRecord* record;
    OsStatus status;

    if (!g_runtime_initialized && browser_runtime_init() != (int)OS_STATUS_OK)
    {
        return 0U;
    }

    if (wasm_bytes == NULL || wasm_size == 0U)
    {
        browser_set_error("browser_task_create", OS_STATUS_INVALID_ARGUMENT);
        return 0U;
    }

    record = (BrowserTaskRecord*)calloc(1U, sizeof(BrowserTaskRecord));
    if (record == NULL)
    {
        browser_set_error("browser_task_create", OS_STATUS_OUT_OF_MEMORY);
        return 0U;
    }

    record->wasm_bytes = (uint8_t*)malloc(wasm_size);
    record->entry_function_name = browser_duplicate_string(
        entry_function_name != NULL && entry_function_name[0] != '\0'
            ? entry_function_name
            : "app_main"
    );

    if (record->wasm_bytes == NULL || record->entry_function_name == NULL)
    {
        free(record->entry_function_name);
        free(record->wasm_bytes);
        free(record);
        browser_set_error("browser_task_create", OS_STATUS_OUT_OF_MEMORY);
        return 0U;
    }

    memcpy(record->wasm_bytes, wasm_bytes, wasm_size);
    status = os_task_create(
        &record->task,
        record->wasm_bytes,
        wasm_size,
        record->entry_function_name,
        task_name,
        stack_size == 0U ? BROWSER_DEFAULT_STACK_SIZE : stack_size,
        priority
    );

    if (status != OS_STATUS_OK || record->task == NULL)
    {
        browser_set_error("os_task_create", status);
        free(record->entry_function_name);
        free(record->wasm_bytes);
        free(record);
        return 0U;
    }

    record->task_id = os_task_get_id(record->task);
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

    if (max_slices == 0U)
    {
        max_slices = 1U;
    }
    if (max_slices > BROWSER_MAX_SLICES_PER_FRAME)
    {
        max_slices = BROWSER_MAX_SLICES_PER_FRAME;
    }

    for (slice = 0U; slice < max_slices; ++slice)
    {
        status = os_schedule();
        if (status == OS_STATUS_NO_READY_TASKS)
        {
            return (int)OS_STATUS_OK;
        }
        if (status != OS_STATUS_OK)
        {
            browser_set_error("os_schedule", status);
            return (int)status;
        }
    }

    return (int)OS_STATUS_OK;
}

EMSCRIPTEN_KEEPALIVE
void browser_runtime_set_slices_per_frame(uint32_t slice_count)
{
    if (slice_count == 0U)
    {
        slice_count = 1U;
    }
    if (slice_count > BROWSER_MAX_SLICES_PER_FRAME)
    {
        slice_count = BROWSER_MAX_SLICES_PER_FRAME;
    }
    g_slices_per_frame = slice_count;
}

EMSCRIPTEN_KEEPALIVE
uint32_t browser_task_get_state(uint32_t task_id)
{
    BrowserTaskRecord* record = browser_find_record(task_id);
    return record != NULL ? (uint32_t)os_task_get_state(record->task) : (uint32_t)OS_TASK_DEAD;
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
    (void)browser_runtime_step(hal_get_time_ms(), g_slices_per_frame);
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

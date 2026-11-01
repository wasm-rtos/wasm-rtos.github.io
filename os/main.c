/*
 * Browser entry point for wasm-rtos.
 *
 * Build this file with Emscripten together with the kernel sources in
 * os/wasm-rtos and wasm3. It supplies the kernel clock port from the
 * browser's clock and a GPIO port for the parts drawn on the page.
 */

#include "os/wasm-rtos/os.h"
#include "os/wasm-rtos/fs.h"

#include <emscripten/emscripten.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
/* Pins GPIO0..GPIO7 of the simulated board. */
#define BROWSER_GPIO_PINS 8U

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

/* The board's pins, and the parts drawn on the page under their names. */
static OsStatus browser_gpio_start(void)
{
    static const char* const names[BROWSER_GPIO_PINS] =
    {
        "gpio0", "gpio1", "gpio2", "gpio3", "gpio4", "gpio5", "gpio6", "gpio7"
    };
    OsStatus status = os_gpio_port_set(&g_browser_gpio_port);
    uint32_t pin = 0U;

    memset(&g_board, 0, sizeof(g_board));
    for (pin = 0U; status == OS_STATUS_OK && pin < BROWSER_GPIO_PINS; ++pin)
    {
        status = os_gpio_add_pin(names[pin], pin, OS_GPIO_CAN_ALL, 0U);
    }
    if (status == OS_STATUS_OK)
    {
        status = os_gpio_add_pin("button-a", 0U, OS_GPIO_CAN_ALL, 0U);
    }
    if (status == OS_STATUS_OK)
    {
        status = os_gpio_add_pin("led", 2U, OS_GPIO_CAN_ALL, 0U);
    }
    return status;
}

typedef struct BrowserTaskRecord
{
    uint32_t task_id;
    uint32_t observed_run_count;
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

static const uint8_t* browser_fs_map(void* context, void* handle, uint64_t* out_size)
{
    BrowserFile* file = (BrowserFile*)handle;
    (void)context;

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
    browser_clock_start();
    status = os_init();
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_init", status);
        browser_clock_stop();
        return (int)status;
    }

    status = os_fs_mount(BROWSER_FS_MOUNT, &g_browser_fs_driver, NULL);
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_fs_mount", status);
        os_shutdown();
        browser_clock_stop();
        return (int)status;
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
        return (int)status;
    }

    status = browser_gpio_start();
    if (status != OS_STATUS_OK)
    {
        browser_set_error("os_gpio_add_pin", status);
        os_shutdown();
        browser_clock_stop();
        return (int)status;
    }

    g_runtime_initialized = 1;
    g_last_budget_time_ms = g_clock_now_ms;
    g_fuel_budget = 0.0;
    g_scheduled_slice_count = 0U;
    browser_trace_reset();
    return (int)OS_STATUS_OK;
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
        double slice_started_at_ms = browser_elapsed_now_ms();
        double slice_finished_at_ms;

        status = os_schedule();
        slice_finished_at_ms = browser_elapsed_now_ms();
        browser_trace_capture_slice(slice_started_at_ms, slice_finished_at_ms);
        if (status == OS_STATUS_NO_READY_TASKS)
        {
            return (int)OS_STATUS_OK;
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

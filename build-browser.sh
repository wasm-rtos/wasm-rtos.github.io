#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

EMCC_BIN="${EMCC:-emcc}"
OUTPUT_JS="os/wasm-rtos.js"
OUTPUT_WASM="os/wasm-rtos.wasm"
WASM_RTOS_DIR="os/wasm-rtos"
VM_SOURCE_DIR="$WASM_RTOS_DIR/vm/source"

if ! command -v "$EMCC_BIN" >/dev/null 2>&1; then
    echo "FAIL Emscripten compiler not found: $EMCC_BIN"
    exit 1
fi

required_files=(
    "os/main.c"
    "$WASM_RTOS_DIR/os.c"
    "$WASM_RTOS_DIR/os.h"
)

for required_file in "${required_files[@]}"; do
    if [ ! -f "$required_file" ]; then
        echo "FAIL required source file is missing: $required_file"
        exit 1
    fi
done

if [ ! -d "$VM_SOURCE_DIR" ]; then
    echo "FAIL interpreter source directory is missing: $VM_SOURCE_DIR"
    exit 1
fi

# Every kernel source; os/main.c supplies the kernel clock port.
kernel_sources=()
while IFS= read -r kernel_source; do
    kernel_sources+=("$kernel_source")
done < <(find "$WASM_RTOS_DIR" -maxdepth 1 -type f -name '*.c' -print | sort)
if [ "${#kernel_sources[@]}" -eq 0 ]; then
    echo "FAIL no kernel C sources found in $WASM_RTOS_DIR"
    exit 1
fi

vm_sources=()
while IFS= read -r vm_source; do
    vm_sources+=("$vm_source")
done < <(find "$VM_SOURCE_DIR" -maxdepth 1 -type f -name '*.c' -print | sort)
if [ "${#vm_sources[@]}" -eq 0 ]; then
    echo "FAIL no interpreter C sources found in $VM_SOURCE_DIR"
    exit 1
fi

exported_functions='["_main","_malloc","_free","_browser_runtime_init","_browser_runtime_shutdown","_browser_task_spawn","_browser_fs_write","_browser_fs_remove","_browser_fs_list","_browser_fs_file_size","_browser_task_delete","_browser_task_suspend","_browser_task_resume","_browser_task_set_priority","_browser_runtime_step","_browser_runtime_set_slices_per_frame","_browser_runtime_set_fuel_per_ms","_browser_runtime_get_fuel_per_ms","_browser_runtime_get_fuel_per_slice","_browser_runtime_get_scheduled_slice_count","_browser_trace_get_oldest_sequence","_browser_trace_get_latest_sequence","_browser_trace_get_clock_ms","_browser_trace_read","_browser_task_get_state","_browser_task_get_memory_usage","_browser_task_get_app_name","_browser_task_get_error","_browser_task_swap_out","_browser_gpio_add_pin","_browser_gpio_get_owner","_browser_i2c_add_bus","_browser_spi_add_bus","_browser_chip_add_lm75","_browser_chip_set_temperature","_browser_chip_add_gc9a01","_browser_chip_framebuffer","_browser_chip_take_dirty","_browser_chip_is_showing","_browser_bus_get_latest_sequence","_browser_bus_get_event","_browser_bus_event_size","_browser_display_add","_browser_display_framebuffer","_browser_display_take_dirty","_browser_display_get_brightness","_browser_display_get_owner","_browser_input_add","_browser_input_key","_browser_input_rotate","_browser_input_touch","_browser_input_text","_browser_input_get_owner","_browser_gpio_get_level","_browser_gpio_ground","_browser_task_is_swapped","_browser_task_get_priority","_browser_task_get_run_count","_browser_task_get_fuel_used","_browser_task_get_cpu_ms","_browser_task_get_exit_reason","_browser_task_get_exit_code","_browser_runtime_get_task_count","_browser_runtime_get_ready_task_count","_browser_runtime_get_waiting_task_count","_browser_runtime_get_timer_count","_browser_runtime_get_last_error","_browser_runtime_set_ram_frames","_browser_runtime_get_page_stats","_browser_system_sleep","_browser_system_boot","_browser_system_restore","_browser_system_is_asleep","_browser_board_state_size","_browser_board_state_write","_browser_board_state_read","_browser_build_id","_browser_system_power_down"]'
exported_runtime_methods='["ccall","cwrap","UTF8ToString","HEAPU8"]'

rm -f "$OUTPUT_JS" "$OUTPUT_WASM"

"$EMCC_BIN" \
    -std=c11 \
    -O2 \
    -Wall \
    -Wextra \
    -D_GNU_SOURCE \
    -I. \
    -I"$WASM_RTOS_DIR" \
    os/main.c \
    "${kernel_sources[@]}" \
    "${vm_sources[@]}" \
    -sWASM=1 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sNO_EXIT_RUNTIME=1 \
    -sMODULARIZE=1 \
    -sEXPORT_NAME=createWasmRtosModule \
    -sENVIRONMENT=web \
    -sEXPORTED_FUNCTIONS="$exported_functions" \
    -sEXPORTED_RUNTIME_METHODS="$exported_runtime_methods" \
    -o "$OUTPUT_JS"

if [ ! -s "$OUTPUT_JS" ]; then
    echo "FAIL generated JavaScript loader is missing or empty: $OUTPUT_JS"
    exit 1
fi

if [ ! -s "$OUTPUT_WASM" ]; then
    echo "FAIL generated WebAssembly runtime is missing or empty: $OUTPUT_WASM"
    exit 1
fi

if ! grep -q 'HEAPU8' "$OUTPUT_JS"; then
    echo "FAIL generated JavaScript loader does not expose HEAPU8"
    exit 1
fi

if ! grep -q 'browser_trace_read' "$OUTPUT_JS"; then
    echo "FAIL generated JavaScript loader does not expose scheduler trace telemetry"
    exit 1
fi

echo "Generated browser runtime:"
ls -lh "$OUTPUT_JS" "$OUTPUT_WASM"

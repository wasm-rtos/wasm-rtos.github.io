#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

EMCC_BIN="${EMCC:-emcc}"
OUTPUT_JS="os/wasm-rtos.js"
OUTPUT_WASM="os/wasm-rtos.wasm"
WASM_RTOS_DIR="os/wasm-rtos"
WASM3_SOURCE_DIR="$WASM_RTOS_DIR/wasm3/source"

if ! command -v "$EMCC_BIN" >/dev/null 2>&1; then
    echo "FAIL Emscripten compiler not found: $EMCC_BIN"
    exit 1
fi

required_files=(
    "os/main.c"
    "$WASM_RTOS_DIR/os.c"
    "$WASM_RTOS_DIR/os.h"
    "$WASM_RTOS_DIR/hal.h"
)

for required_file in "${required_files[@]}"; do
    if [ ! -f "$required_file" ]; then
        echo "FAIL required source file is missing: $required_file"
        exit 1
    fi
done

if [ ! -d "$WASM3_SOURCE_DIR" ]; then
    echo "FAIL wasm3 source directory is missing: $WASM3_SOURCE_DIR"
    exit 1
fi

mapfile -t wasm3_sources < <(find "$WASM3_SOURCE_DIR" -maxdepth 1 -type f -name '*.c' -print | sort)
if [ "${#wasm3_sources[@]}" -eq 0 ]; then
    echo "FAIL no wasm3 C sources found in $WASM3_SOURCE_DIR"
    exit 1
fi

exported_functions='["_main","_malloc","_free","_browser_runtime_init","_browser_runtime_shutdown","_browser_task_create","_browser_task_delete","_browser_task_suspend","_browser_task_resume","_browser_task_set_priority","_browser_runtime_step","_browser_runtime_set_slices_per_frame","_browser_runtime_set_fuel_per_ms","_browser_runtime_get_fuel_per_ms","_browser_runtime_get_fuel_per_slice","_browser_runtime_get_scheduled_slice_count","_browser_trace_get_oldest_sequence","_browser_trace_get_latest_sequence","_browser_trace_get_clock_ms","_browser_trace_read","_browser_task_get_state","_browser_task_get_priority","_browser_task_get_run_count","_browser_task_get_exit_reason","_browser_task_get_exit_code","_browser_runtime_get_task_count","_browser_runtime_get_ready_task_count","_browser_runtime_get_waiting_task_count","_browser_runtime_get_timer_count","_browser_runtime_get_last_error"]'
exported_runtime_methods='["ccall","cwrap","UTF8ToString","HEAPU8"]'

rm -f "$OUTPUT_JS" "$OUTPUT_WASM"

"$EMCC_BIN" \
    -std=c11 \
    -O2 \
    -Wall \
    -Wextra \
    -D_GNU_SOURCE \
    -Dd_m3HasWASI \
    -I. \
    -I"$WASM_RTOS_DIR" \
    -I"$WASM3_SOURCE_DIR" \
    os/main.c \
    "$WASM_RTOS_DIR/os.c" \
    "${wasm3_sources[@]}" \
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

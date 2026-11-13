/*
 * The simulated chip's heap (docs/decisions.md, 2). The kernel and the
 * interpreter are built with this header forced in, so their malloc,
 * calloc, realloc and free come from the chip's regions; the page's own
 * code (os/main.c) undefines these after its includes and uses the
 * browser's heap.
 */
#ifndef BROWSER_CHIP_HEAP_H
#define BROWSER_CHIP_HEAP_H

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

void* chip_malloc(size_t size);
void* chip_calloc(size_t count, size_t size);
void* chip_realloc(void* pointer, size_t size);
void chip_free(void* pointer);

/* Regions in bytes; count 0 for no chip limit (the browser's heap). Only while nothing is allocated from them. */
int chip_heap_set(const uint32_t* sizes, uint32_t count);
/* Per region: [free, largest free block, size]; returns the number of regions. */
uint32_t chip_heap_stats(uint32_t* out, uint32_t max_regions);

#ifndef BROWSER_CHIP_HEAP_IMPLEMENTATION
#define malloc(size) chip_malloc(size)
#define calloc(count, size) chip_calloc((count), (size))
#define realloc(pointer, size) chip_realloc((pointer), (size))
#define free(pointer) chip_free(pointer)
#endif

#endif

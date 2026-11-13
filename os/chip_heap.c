/*
 * The simulated chip's heap: separate regions, as a small chip's RAM is
 * (an ESP32 without PSRAM has ten). An allocation takes the first region
 * that has a block large enough, and in it the smallest such block; every
 * block costs a header and a footer, 4 bytes each, like the chip's
 * allocator. Freed blocks join their free neighbours. A pointer from
 * outside the regions (made before the chip was set, or by the C library
 * for itself) goes back to the browser's heap.
 */
#define BROWSER_CHIP_HEAP_IMPLEMENTATION
#include "chip_heap.h"

/* The build forces chip_heap.h into every file; here malloc is the browser's. */
#undef malloc
#undef calloc
#undef realloc
#undef free

#include <string.h>

#define CHIP_REGIONS_MAX 16U
#define CHIP_ALIGN 8U
#define CHIP_OVERHEAD 8U /* header and footer */
#define CHIP_MIN_BLOCK 16U
#define CHIP_USED 1U

typedef struct
{
    uint8_t* base;
    uint32_t size;
} ChipRegion;

static ChipRegion g_regions[CHIP_REGIONS_MAX];
static uint32_t g_region_count;

static uint32_t* header_at(uint8_t* block) { return (uint32_t*)block; }
static uint32_t block_size(uint8_t* block) { return *header_at(block) & ~CHIP_USED; }
static int block_used(uint8_t* block) { return (*header_at(block) & CHIP_USED) != 0U; }

static void block_mark(uint8_t* block, uint32_t size, int used)
{
    uint32_t tag = size | (used ? CHIP_USED : 0U);
    *header_at(block) = tag;
    *(uint32_t*)(block + size - 4U) = tag;
}

static ChipRegion* region_of(const void* pointer)
{
    for (uint32_t i = 0; i < g_region_count; ++i)
        if ((const uint8_t*)pointer >= g_regions[i].base && (const uint8_t*)pointer < g_regions[i].base + g_regions[i].size)
            return &g_regions[i];
    return NULL;
}

int chip_heap_set(const uint32_t* sizes, uint32_t count)
{
    for (uint32_t i = 0; i < g_region_count; ++i)
        free(g_regions[i].base);
    g_region_count = 0U;
    for (uint32_t i = 0; i < count && i < CHIP_REGIONS_MAX; ++i)
    {
        uint32_t size = sizes[i] & ~(CHIP_ALIGN - 1U);
        if (size < CHIP_MIN_BLOCK)
            continue;
        /* Offset by 4 so that payloads, after the 4-byte header, are 8-aligned. */
        uint8_t* raw = (uint8_t*)malloc((size_t)size + CHIP_ALIGN);
        if (raw == NULL)
            return 1;
        g_regions[g_region_count].base = raw + 4U;
        g_regions[g_region_count].size = size;
        block_mark(raw + 4U, size, 0);
        ++g_region_count;
    }
    return 0;
}

static void* region_take(ChipRegion* region, uint32_t need)
{
    uint8_t* best = NULL;
    uint8_t* end = region->base + region->size;
    for (uint8_t* block = region->base; block < end; block += block_size(block))
        if (!block_used(block) && block_size(block) >= need && (best == NULL || block_size(block) < block_size(best)))
            best = block;
    if (best == NULL)
        return NULL;
    uint32_t have = block_size(best);
    if (have - need >= CHIP_MIN_BLOCK)
    {
        block_mark(best, need, 1);
        block_mark(best + need, have - need, 0);
    }
    else
        block_mark(best, have, 1);
    return best + 4U;
}

static uint32_t block_need(size_t size)
{
    size_t need = (size + CHIP_OVERHEAD + CHIP_ALIGN - 1U) & ~(size_t)(CHIP_ALIGN - 1U);
    return need < CHIP_MIN_BLOCK ? CHIP_MIN_BLOCK : (uint32_t)need;
}

void* chip_malloc(size_t size)
{
    if (g_region_count == 0U)
        return malloc(size);
    if (size > 0x7fffffffU)
        return NULL;
    uint32_t need = block_need(size);
    for (uint32_t i = 0; i < g_region_count; ++i)
    {
        void* p = region_take(&g_regions[i], need);
        if (p != NULL)
            return p;
    }
    return NULL;
}

void* chip_calloc(size_t count, size_t size)
{
    if (size != 0U && count > (size_t)-1 / size)
        return NULL;
    void* p = chip_malloc(count * size);
    if (p != NULL)
        memset(p, 0, count * size);
    return p;
}

void chip_free(void* pointer)
{
    ChipRegion* region = pointer != NULL ? region_of(pointer) : NULL;
    if (pointer == NULL)
        return;
    if (region == NULL)
    {
        free(pointer);
        return;
    }
    uint8_t* block = (uint8_t*)pointer - 4U;
    uint32_t size = block_size(block);
    uint8_t* next = block + size;
    if (next < region->base + region->size && !block_used(next))
        size += block_size(next);
    if (block > region->base)
    {
        uint32_t before = *(uint32_t*)(block - 4U);
        if ((before & CHIP_USED) == 0U)
        {
            block -= before;
            size += before;
        }
    }
    block_mark(block, size, 0);
}

void* chip_realloc(void* pointer, size_t size)
{
    ChipRegion* region = pointer != NULL ? region_of(pointer) : NULL;
    if (pointer == NULL)
        return chip_malloc(size);
    if (size == 0U)
    {
        chip_free(pointer);
        return NULL;
    }
    if (region == NULL)
        return realloc(pointer, size);
    uint8_t* block = (uint8_t*)pointer - 4U;
    uint32_t have = block_size(block);
    uint32_t need = block_need(size);
    uint8_t* next = block + have;
    /* Grow into a free neighbour, as the chip's allocator does, before moving. */
    if (need > have && next < region->base + region->size && !block_used(next) && have + block_size(next) >= need)
    {
        uint32_t joined = have + block_size(next);
        block_mark(block, joined, 1);
        have = joined;
    }
    if (need <= have)
    {
        if (have - need >= CHIP_MIN_BLOCK)
        {
            /* The rest goes back, joining a free neighbour after it. */
            block_mark(block, need, 1);
            block_mark(block + need, have - need, 1);
            chip_free(block + need + 4U);
        }
        return pointer;
    }
    void* moved = chip_malloc(size);
    if (moved == NULL)
        return NULL;
    memcpy(moved, pointer, have - CHIP_OVERHEAD);
    chip_free(pointer);
    return moved;
}

uint32_t chip_heap_stats(uint32_t* out, uint32_t max_regions)
{
    uint32_t n = 0;
    for (; n < g_region_count && n < max_regions; ++n)
    {
        ChipRegion* region = &g_regions[n];
        uint32_t free_bytes = 0, largest = 0;
        for (uint8_t* block = region->base; block < region->base + region->size; block += block_size(block))
            if (!block_used(block))
            {
                uint32_t usable = block_size(block) - CHIP_OVERHEAD;
                free_bytes += usable;
                if (usable > largest)
                    largest = usable;
            }
        out[n * 3U] = free_bytes;
        out[n * 3U + 1U] = largest;
        out[n * 3U + 2U] = region->size;
    }
    return n;
}

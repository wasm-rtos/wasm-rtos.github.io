# Decisions

The choices that shape the simulator: what was decided, why, and what was
considered instead. New entries start as **Proposed** and are built only
once agreed.

## 1. The simulator runs the current kernel: paged memory and sleep

**Decided and built (2026-11-13).**

### Problem

The page builds the kernel from the commit of 11 November (wasm-rtos#53).
Seventeen changes later the kernel no longer has the swap port the page
gives it (`OsSwapPort`): swapping out, and since then all program memory,
goes through a page store of fixed-size frames (`OsPageStore`). The page
does not build on the current kernel. It also cannot show what the kernel
gained since: memory paged frame by frame under a RAM budget, memory kept
in one block while it fits, and a whole system saved before a deep sleep
and restored after it.

The rule for the browser is the same as for a board: the simulator is a
port like the ESP32 and Black Pill ones, and a program behaves on it as it
does there.

### Decision

**A page store outside the runtime's memory.** Frames (4 KiB) live in
JavaScript, one `Uint8Array` per slot, as swap images did, so a frame sent
out really leaves the runtime's memory. Reads and writes are synchronous:
the page has one thread, and a frame copy takes microseconds. 16384 slots
(64 MiB): enough that memory is never refused because of the store.

**A RAM budget per device.** (Since decision 2 the budget is the chip's,
not the profile's.) Each profile in `DEVICE_PROFILES` states how
much RAM programs' memory may use, as a board does:

| Profile | RAM for programs | Why |
|---|---|---|
| Dev board | 80 KiB (20 frames) | what an ESP32 without PSRAM can give the pool (16–20 frames measured) |
| Watch | 2 MiB (512 frames) | a watch chip with PSRAM |

Programs still get the memory they ask for; beyond the budget their frames
go to the store and come back when touched, as on the ESP32 with its SD
card. The Inspector shows the paging: frames in RAM of the budget, frames
stored, writes and reads so far, and per program whether its memory is one
block or paged.

**Swap out** stays as it is (the program's button), now through the store.

**Sleep.** A **Sleep** button saves the whole system (`os_system_save`) and
shuts the kernel down; the board is drawn asleep. It wakes as a board does:

- at the kernel's next deadline (`os_get_next_wakeup_ms`), or never if
  nothing waits for time;
- on an edge of a pin a program watches (`os_gpio_wake_pins`): pressing the
  board's button;
- with the same button pressed again (**Wake**), standing for a reset.

Waking starts a fresh kernel, sets the ports up, and restores the system
with the time actually slept (`os_system_restore`, `slept_ms`). Programs go
on where they were; the Inspector rebuilds its program list from the
kernel. The log says how big the saved system was and how long saving and
restoring took.

**The board's parts keep power.** The chips on the buses (LM75, GC9A01),
the OLED and the watch display are models in the page: they keep their
state through a sleep, as parts powered from the battery do. So the
displays report that they keep their image (`OsDisplayInfo.keeps_image`),
and a program holding a display can sleep.

**A sleep survives a reload.** The saved system and the parts' state
(framebuffers, the chips' registers, the LM75's temperature) go into
IndexedDB next to the files. Loading the page with a saved system there
wakes it, with the time since the save as `slept_ms`, after `/sd` is
restored (programs started by path are opened from it again). **Start
fresh** throws the saved system away. A saved system from another runtime
build or device profile is thrown away with a message: the page stores the
runtime's build and the profile with it and wakes only a match.

### Why

- A port has to keep up with the kernel; the simulator is where people see
  it first.
- A budget per device makes paging visible on the page, with the same
  policy and the same numbers as on the boards, instead of a browser that
  never runs out of RAM.
- Sleeping and waking in the browser is the same code path as the ESP32's
  deep sleep, so a program can be checked for it without a board.
- Keeping the parts powered matches what the kernel was built for (a
  display that keeps its image may be held across a sleep), and lets every
  example sleep.

### Instead

- **Frames in the runtime's own heap**: simpler, but swapping out would
  free nothing, and the budget would mean nothing.
- **Frames in IndexedDB**: a store that survives reloads, but its reads are
  asynchronous; the kernel's background reads (`read_start`) could serve
  it, at the cost of much more code. A later step if wanted.
- **No budget (unlimited RAM)**: paging would never happen on the page.
- **A budget the user picks**: another setting; a device profile already
  says what the device is. (Revisited in decision 2: the budget and the
  heap belong to the chip, which the person picks or makes.)
- **Displays that lose their image**: realistic for some boards, but then
  no program with a display could sleep on the page.

### Work, all of it

| # | What | Where | Status |
|---|---|---|---|
| 1 | Kernel submodule to current main; the page store in JavaScript in place of the swap port; budgets in the profiles | `os/main.c`, `main.js` | done |
| 2 | Paging in the Inspector: frames in RAM of the budget, stored, writes, reads; one block or paged per program | `os/main.c`, `main.js`, `index.html` | done |
| 3 | Sleep and wake: Sleep and Wake buttons, the deadline and pin wakes, restore with the time slept, the program list rebuilt; displays keep their image | `os/main.c`, `main.js`, `index.html` | done |
| 4 | The saved system and the parts' state in IndexedDB; waking after a reload; Start fresh; a stale one refused | `main.js`, `os/main.c` | done |
| 5 | Check in a browser: every example on both profiles; a program paging under the budget; sleep and wake by timer, button and Wake; a sleep across a reload; numbers in the log | | done |
| 6 | README; the runtime rebuilt by CI | `README.md` | done |

## 2. The chip is a setting, with presets measured on real boards

**Decided and built (2026-11-13).**

### Problem

A program that runs on the page can fail on the board it was written for.
Measured on an ESP32 without PSRAM: the tour example (40 KB, with
`printf`) does not even load with 20 frames of RAM for programs, because
the board's heap is ten separate regions and the frame pool takes the
largest; with 16 it runs. The page has one heap as large as the browser
allows, so it runs the same program with any budget and never says so.
Decision 1 put a RAM budget in each device profile and rejected a budget
the person picks; both are now too little: what fails on a board is the
heap and how it is cut up, and that belongs to the chip, not to what is
wired to it.

### Decision

**A Chip section in the Inspector,** under Processor: the chip the device
has, picked from a list of chips measured on real boards and of the
person's own. Changing the chip restarts the device, as changing the
device profile does; the choice is kept per device profile.

**Anyone can make a chip.** New chip opens a short form: a name, the
clock in MHz, the RAM in KB, and what holds frames (SD card, memory,
none). That is enough: the page works out the rest from the measured
ESP32 (speed from the clock, 10 000 fuel/ms at 240 MHz, an estimate for
chips of another kind; RAM for programs a quarter of the RAM; the SD
card's timings). Details, folded, hold every value for those who know
better: the RAM's regions, the frames for programs, the store's slots and
timings, the speed in fuel/ms. A chip of one's own is kept in the browser,
can be edited, deleted, made from a copy of any chip, and downloaded as a
file that someone else loads.

| Setting | What the page does with it |
|---|---|
| Heap regions | The kernel and the interpreter allocate only from these regions, each a separate piece of memory, first fit across regions in order and best fit inside one, with the chip's block overhead. The frame pool, programs' bytes, modules, stacks: all come from here, so "out of memory" and "the largest block is too small" happen where they happen on the chip. |
| RAM for programs | The page store's budget, in frames (decision 1). |
| Page store | What holds frames out of RAM (SD card, memory, none), its slots, and how long a frame takes to write and to read. On an SD card the whole chip waits that long for each frame, as on the board port, whose card is written and read in the call; and programs are read from the card into the chip's RAM (on the page they could run in place). |
| Speed | Fuel per millisecond: the slider the page has starts at the chip's. |

The page's own parts (the board drawing, framebuffers, the simulated
chips on the buses) stay outside the chip's heap: they are not on the chip.
The Processor panel shows the heap: free, the largest block, per region.

**Presets are measurements, not guesses.** Each preset says where its
numbers come from. The first two:

| Preset | Heap regions (free at boot) | RAM for programs | Page store | Speed | Source |
|---|---|---|---|---|---|
| ESP32, no PSRAM | 2, 1, 16, 14, 60, 5 and 108 KB (206 KB): the largest free block of each region when the kernel starts, after the firmware has the card and its buffers | 16 frames (64 KB) | SD card, 256 slots, 34.6 ms a write, 13 ms a read, timed while a program paged | 10 000 fuel/ms | measured on an ESP32-D0WDQ6 with the board port, 2026-11-13 |
| Unlimited | one region, as large as the browser gives | 512 frames (2 MB) | in memory, no delay | 2 400 fuel/ms | the page as it was |

A board joins the list when it has been measured the same way (heap
regions at boot, a frame's time to the store, the speed of a program that
only computes); until then anyone can make it as a chip of their own. The
dev board profile starts with the ESP32, the watch with Unlimited.

**The check that the model is honest:** the tour on the ESP32 preset
fails to load with 20 frames and runs with 16, as on the board; the free
heap and largest block after it starts are close to the board's.

Measured against the board (2026-11-13):

| | Board | Page, ESP32 chip |
|---|---|---|
| The tour, 16 frames | runs | runs |
| The tour, 20 frames | `exhaustion: out of memory` while parsing the module | the same, in the same place |
| A program walking 256 KB | 20.6 s; 448 frames out, 396 in | 21.1 s; 436 out, 384 in |
| Largest free block once the kernel started | 61 428 bytes | 60 KB |
| Fuel of a program that only computes | 30 623 951 | 30 623 987 |

Two first measurements were wrong and are kept here so they are not made
again: the heap read at boot (251 KB) is not what the kernel gets (206 KB,
the firmware takes the rest first), and a frame's time to the card in a
short loop at start (10.6 ms, 9.6 ms) is not its time while programs page
(34.6 ms, 13 ms).

### Why

- The page is where programs are written for boards; it has to run out of
  memory where the board does, or it promises what the board cannot do.
- Fragmentation is the real limit on small chips (251 KB free, nothing
  larger than 113 KB), so the model needs regions, not one number.
- Measured presets keep the page honest; Custom keeps it useful for boards
  nobody has measured yet.

### Instead

- **One heap limit**: simpler, but the tour would load with 20 frames on
  the page and not on the board.
- **The chip's own allocator, ported**: closest, but large and different
  per chip; first fit across regions and best fit inside one is what the
  ESP32's allocator does near enough for programs to fail at the same
  sizes, which the check above verifies.
- **Presets from datasheets** (ESP32 with PSRAM, S3, STM32): numbers that
  were never measured would make the page wrong with confidence.

### Work, all of it

| # | What | Where | Status |
|---|---|---|---|
| 1 | The chip's heap: regions, first fit across and best fit inside, block overhead, statistics; the kernel's and interpreter's allocations go to it, the page's own do not | `os/chip_heap.c`, `build-browser.sh`, `os/main.c` | done |
| 2 | The page store's delay: on an SD card the chip waits for each frame, and programs are read into its RAM | `os/main.c` | done |
| 3 | Measured chips as data; chips of one's own (form with details, kept in the browser, copy, edit, delete, download and load a file); the chip per device profile; restart on change; budgets leave the profiles | `main.js`, `index.html`, `style.css` | done |
| 4 | Heap in the Processor panel: free, largest block, per region | `main.js`, `os/main.c` | done |
| 5 | The check: the tour on the ESP32 preset fails with 20 frames and runs with 16; heap after start compared with the board; every example on both profiles; the earlier browser checks | | done |
| 6 | README; decision 1's table and Instead point here | `README.md`, `docs/decisions.md` | done |

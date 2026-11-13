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

## 3. A board on the serial cable

**Decided and built (2026-11-13).**

### Problem

A program is written on the page and then has to reach the board: today
that takes PlatformIO or a script, and what the board prints is read in a
separate serial monitor. The page cannot see the board at all, so nothing
on it can be compared with what the board does.

### Decision

**One protocol on the board's serial port, spoken by a script and by the
page.** The board port (the ESP32 firmware) frames everything it sends and
receives, so programs' output and the commands' bytes never mix:

```
0xA5 | type u8 | id u16 | slot u32 | length u16 | payload | crc32 u32
```

| Type | Way | What |
|---|---|---|
| `HELLO` | both | on connect: the protocol version, the chip's frame size, its board and firmware names; then once a second while connected |
| `CONSOLE` | board → | a line a program wrote; `slot` is its task |
| `PUT` | → board | a file for the card, 512 bytes a packet, each answered |
| `RUN`, `KILL`, `LIST`, `PS` | → board | start a program by path with arguments, stop one, list a folder, list the programs |
| `RESULT` | board → | the answer to a command: status and text; `TASK_ENDED` when a program ends, with its exit code |
| `FS_STAT`, `FS_READ`, `FS_LIST` | board → | the board reading the computer's files: a file's type and size, up to 4 KB of it at an offset, a folder's entry by index; answered with `FS_ANSWER` |
| `PAGE_WRITE`, `PAGE_READ` | board → | without a card, a frame of programs' memory kept on the computer and read back (`slot`); answered with `FS_ANSWER` |

`id` pairs an answer with its command. A damaged packet is dropped and its
command times out; the sender says so. Both ends say `HELLO` once a
second; after three silent seconds the board takes the cable as gone, and
what it asks of the computer fails at once.

**No SD card needed.** The board mounts the computer's files (the page's
Files, or a folder the script serves) as a file system over the cable:
at `/sd` on a board without a card, at `/pc` on one with a card (whose
`/sd` stays the card). The kernel reads them like any file: a program
started from there is read into RAM, as from a card, and it can open its
own files and start children by path. While a read crosses the cable the
board waits, as for a card; with the cable gone, reads fail and the
programs reading see an error.

**On the page:** a Board button in the toolbar (Chrome and Edge, which
have Web Serial; hidden elsewhere). Once the person picks the port:

- the board's output appears in the Console, each line marked
  `board task_1:`;
- a `.wasm` in Files has **Run on board** next to Run: the board starts it
  from the page's files, without a card (or, with **Put on card**, copies
  it to the card first, to run without the computer later);
- a Board section in the Inspector shows the board (its name, firmware,
  card, where its pages are) and the programs started on it, with Stop.

**The script** (`board.py`, kept with the board tests) speaks the same
protocol, for checks without a browser.

**The computer as the page store**, on a board without a card: frames go
over the cable and are kept by the page (or the script) while it is
connected. The chip waits for each, as for a card, but longer (about 65 ms
a frame at 921 600 baud, against 13 to 35 ms on the card). With the cable
gone, the programs whose frames were there end with an error; the board
and its other programs go on.

### Why

- The page is where programs are made; putting them on the board and
  reading what it says belong there, with no other tool.
- Framing keeps text and binary apart, so the same cable can carry
  frames of memory later without a new protocol.
- One protocol for the page and the script means a check written once
  holds for both.

### Instead

- **Plain text lines** (what the firmware spoke before): simple, but a
  file's bytes or a frame of memory cannot share the line with output.
- **WebUSB**: needs the board's USB chip to cooperate; the ESP32 kit's
  CP2102 is a serial bridge, which Web Serial reaches as it is.
- **Flashing firmware from the page**: possible (esptool-js), left out
  for now.

### Work, all of it

| # | What | Where | Status |
|---|---|---|---|
| 1 | The protocol in the ESP32 port: framing, HELLO, CONSOLE, PUT, RUN, KILL, LIST, PS, RESULT, TASK_ENDED | board tests (local) | done |
| 2 | The computer's files on the board: an `OsFsDriver` over the cable (FS_STAT, FS_READ, FS_LIST), at `/sd` without a card and `/pc` with one | board tests (local) | done |
| 3 | The computer as the page store without a card: PAGE_WRITE, PAGE_READ; the cable gone fails at once | board tests (local) | done |
| 4 | `board.py` on the protocol: put, run, ls, ps, kill, serving a folder and the frames, cutting the cable on purpose | board tests (local) | done |
| 5 | The page: `board.js` (Web Serial), Board button, console lines, serving Files and frames to the board, Run on board and Put on card, the Board section | `board.js`, `index.html`, `style.css`, `os/main.c` | done |
| 6 | Checks: below | | done |
| 7 | README | `README.md` | done |

Checked (2026-11-13), the tour example on the ESP32:

| | Result |
|---|---|
| Script, with the card, the tour from the computer (`/pc`), its child from the card | runs; the child shares the program |
| Script, no card: files and pages from the computer | runs: 74 frames out, 200 in, 40 s; `led: LATE` (the chip waits for frames on the cable) |
| Script, the computer stops answering in the middle | the tour ends in 3 s with an error; the board runs the next program |
| The page in Chrome, no card, Run on board (by the user) | runs: the same lines, 25 s |
| The page against a fake port | every answer's crc, a file's size, bytes and folder, a frame written and read back, a missing frame refused, RUN and TASK_ENDED shown |

The protocol first took so much RAM that the tour's child no longer fit;
answers now go straight where their question waits, and commands are
small.

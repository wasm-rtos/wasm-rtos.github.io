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

**A RAM budget per device.** Each profile in `DEVICE_PROFILES` states how
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
  says what the device is.
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

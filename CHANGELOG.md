# Changelog

## 1.0.0 — 2026-11-13

The first release of the simulator at <https://wasm-rtos.github.io>.

- **A virtual board in the browser** running the real kernel and
  interpreter: a dev board (LED, button, a monochrome OLED, a temperature
  sensor on I2C, a round display on SPI) and a watch (round display,
  bezel, buttons, touch). Programs dropped on the page go to `/sd`, kept
  across reloads, and run by path.
- **Inspector**: each program's state, memory, fuel, CPU time, output and
  failure; a scheduler timeline; a bus analyzer that decodes what the chips
  are told.
- **Chips**: the ESP32 measured on a real board (its heap in regions, RAM
  for programs, its SD card's timings, its speed), so programs run out of
  memory and page where the board does; chips of one's own, with several
  page stores and priorities, kept, copied and shared as files.
- **Paging and sleep**: programs' memory paged under the chip's budget;
  the whole system saved and woken by timer, pin or button, even across a
  reload.
- **A real board on the cable** (Web Serial, with the board port): its
  console, the page's files and memory for it, Run on board, Put on card,
  its page stores' priorities, and **Run on both**, which runs one program
  here and on the board and compares what they print.
- **Examples**, among them `tour.wasm`, which prints the same lines on an
  ESP32 and here.

Decisions: [`docs/decisions.md`](docs/decisions.md).

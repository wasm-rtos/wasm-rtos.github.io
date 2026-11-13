# wasm-rtos.github.io

Browser build of [wasm-rtos](https://github.com/wasm-rtos/wasm-rtos), served with GitHub Pages.

The kernel and its WebAssembly interpreter are compiled with Emscripten into
`os/wasm-rtos.wasm` and the loader `os/wasm-rtos.js`. The page drives that
runtime from `main.js`.

Files and folders dropped on the page go into an in-memory store that the
runtime mounts at `/sd`, like an SD card on a board. The Files panel browses
the kernel's file system; running a `.wasm` file starts it as a process by
path (`os_task_spawn_path`), and it runs from the store without a copy.
IndexedDB keeps a copy of the store, so the files survive a reload.

Simulated devices are described as data in `main.js` (`DEVICE_PROFILES`),
and the Device menu in the Inspector picks one (switching restarts the
simulator). A profile lists the pins, displays and input devices the kernel
lends to programs, under the names programs open them by, and the parts
drawn for them:

- **Dev board**: an LED (`"led"`, GPIO2), a push button (`"button-a"`,
  GPIO0), `gpio0`…`gpio7`, a 128×64 1-bit OLED as display `"main"`, and two
  buses with bare chips on them: an LM75 temperature sensor at 0x48 on
  `"i2c0"` (a slider sets the temperature) and a round GC9A01 panel on
  `"spi0"` with chip select `"lcd-cs"` (GPIO5) and data/command `"lcd-dc"`
  (GPIO4).
- **Watch**: a round 240×240 RGB565 display `"main"`, a bezel (`"bezel"`,
  24 detents a turn: scroll over it or drag it around), two buttons
  (`"buttons"`: Select and Back, long press at 600 ms) and touch on the glass
  (`"touch"`).

The chips on the buses are models that react to the bytes a program sends
the way the real parts do: the LM75 has its pointer and registers, the
GC9A01 takes its commands (CASET, RASET, RAMWR, MADCTL, INVON, DISPON…)
while DC is low and their parameters and pixels while it is high. A driver
written for the part works unchanged. The **Bus** tab lists every
transaction (program, bus, device, bytes each way, result) and says what
it meant to the chip; a frame of pixel writes folds into one line. When a
program drives chip select itself, as Arduino libraries do, the chip is the
one whose chip select pin was low.

Transfers take their time on the wire: the bits at the bus's speed. Short
ones finish in the call, as drivers poll them; from 100 µs on they run in
the background, as with DMA, through the kernel's asynchronous bus ports:
the program waits while the others run, and the Bus tab marks them with
their wire time (a full 240×240 frame at 40 MHz is 23 ms).

The runtime's GPIO port reports what programs drive and what the parts do;
its display port paints into framebuffers the page shows; the page reports
bezel turns, button presses and touches to the kernel's input devices.

`examples/` holds programs that appear under `/sd/examples` on every start:

- `tour.wasm` runs on every board with an LED and a button: it sums its
  own file, computes, pages 256 KB of memory, blinks the LED on time,
  starts itself as a child and waits for the button, printing only what
  must be the same everywhere. On the ESP32 chip and on a real ESP32 it
  prints the same lines; with a board connected, **Run on both** starts it
  here and on the board at once and compares them.

- `watchface.wasm` runs on every profile: it asks the display for its size,
  shape and format and uses whatever inputs the device has.
- `i2cscan.wasm` lists the devices on an I2C bus.
- `thermodial.wasm` reads the LM75 over I2C and draws on the GC9A01 with
  its own SPI driver, a tenth of the screen per transfer.
- `sketch.wasm` is an Arduino sketch built with the kernel's Arduino core
  (`arduino/build.sh`): the LED blinks, the button counts presses through
  an interrupt, the LM75 is read with `Wire`.

Rebuild one with `clang --target=wasm32-wasip1 --sysroot=<wasi-sysroot>
-Ios/wasm-rtos/include -O2 -o examples/<name>.wasm examples/<name>.c`.

Selecting a program in Tasks shows it in the Inspector: its name from its
metadata, state, memory by kind (linear memory, stack and how much of it was
used, compiled code, kernel), the pins, displays and input devices it owns,
and, when it failed, why and
in which functions. It also shows the fuel the program has spent (the
interpreter's work count, the same on every device), the browser time its
slices took, and its own output. The Console shows every program's stdout
and stderr, each line marked with the task that wrote it; the runtime's
output port delivers them per task.

### Chip

The Chip section of the Inspector says what chip the device has, and the
page runs programs within it: the kernel and the interpreter allocate only
from the chip's heap, cut into the regions the real chip has, so a program
runs out of memory on the page where it would on the board. The chip also
sets the RAM for programs' memory, the page store (an SD card makes the
chip wait for every frame, as the board does, and programs are read from
it into RAM) and the speed.

**ESP32 (no PSRAM)** is measured on a real board: 206 KB of heap in seven
regions, 16 frames for programs, an SD card that takes 34.6 ms to write a
frame and 13 ms to read one, 10 000 fuel/ms. On it the page and the board
agree: the same programs fit and the same do not, and paging takes as
long. **Unlimited** is the browser without limits. **New** makes a chip of
your own from a name, a clock and an amount of RAM (Details holds every
other value); chips of your own are kept in the browser, can be copied,
edited and deleted, and downloaded as a file for someone else to load. The
Processor panel shows the chip's heap: free, and the largest block. A chip of your own may have
more page stores than its first, each with a priority (Details, More page
stores): a frame goes to the store of the highest priority with room, so
a chip with fast memory above its SD card can be tried before it exists.
The Processor panel then shows each store's priority and frames.

### A board on the cable

In Chrome and Edge, the Board button (the plug, by the moon) connects a
board running the wasm-rtos ESP32 port over its serial cable (Web Serial).
The board's programs then print into the Console, marked `board task_1:`,
and the board reads the page's files over the cable: at `/sd` on a board
without an SD card, at `/pc` on one with a card. **Run on board** starts
the selected program there; **Put on card** copies it to the board's card;
**Run on both** starts it here and on the board at once and, when both end,
says whether they printed the same lines, or which differ.
Without a card the page also keeps the frames of the board's programs'
memory, so a board with nothing but the cable runs programs larger than
its RAM, a little slowly; unplugging ends the programs whose frames were
here. The Board section in the Inspector shows the board, its
page stores (the card and the computer) with their priorities to change,
and its programs, with Stop.

### Memory

Programs' memory is paged as on a board, in 4 KB frames, through a page
store whose slots live in JavaScript, outside the runtime's memory. The
chip states how much RAM programs may use: 64 KB on the ESP32.
Programs still get the memory they ask for; beyond the budget their frames
go to the store and come back when touched. While all of a program's
memory fits, it stays one block and runs at full speed. The Processor
panel shows the frames in RAM of the budget, the frames stored and how
many went out and came back; a program's Memory row says whether its
memory is one block or paged. Pausing a program, or the ⇣ button, swaps it
out of RAM; it comes back when it runs again.

### Sleep

The ☾ button (or Z) puts the device to sleep the way a board sleeps
deeply: the kernel saves the whole system (programs, what they wait for,
queues, timers, files, the devices they hold) and powers down. The board's
parts keep power, so displays keep their pictures and chips their
registers. The device wakes by its next deadline, by an edge on a pin a
program watches (the dev board's button), or by pressing ☾ again; a fresh
kernel restores the system with the time slept, and the programs go on
where they were. The Console tells how big the saved system was and how
long saving and restoring took.

A sleep survives a reload: the saved system, the parts' state and the
program list are kept in IndexedDB, and the reloaded page is a device still
asleep, woken the same ways. **Start fresh** in the Processor panel throws
the saved system away. A saved system from another runtime build or device
is thrown away when the page loads.

## Building locally

Requirements: Bash 3.2 or newer and Emscripten (macOS: `brew install emscripten`).
CI pins the Emscripten version in `.github/workflows/build-browser.yml`
(`EMSDK_VERSION`); use the same version locally for identical output.

```bash
git submodule update --init --recursive
./build-browser.sh              # writes os/wasm-rtos.js and os/wasm-rtos.wasm
python3 -m http.server 8000     # open http://localhost:8000
```

The page has to be served over HTTP; opening `index.html` from the file system
cannot load the runtime.

## Deployment

`.github/workflows/build-browser.yml` rebuilds the runtime on every push and
pull request that touches the site sources or the `os/wasm-rtos` submodule, and
verifies the outputs. On `main` it also commits the updated runtime files,
which GitHub Pages then serves; other branches and pull requests only build,
so CI never commits to them.

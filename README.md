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
  GPIO0), `gpio0`…`gpio7`, and a 128×64 1-bit OLED as display `"main"`.
- **Watch**: a round 240×240 RGB565 display `"main"`, a bezel (`"bezel"`,
  24 detents a turn: scroll over it or drag it around), two buttons
  (`"buttons"`: Select and Back, long press at 600 ms) and touch on the glass
  (`"touch"`).

The runtime's GPIO port reports what programs drive and what the parts do;
its display port paints into framebuffers the page shows; the page reports
bezel turns, button presses and touches to the kernel's input devices.

`examples/` holds programs that appear under `/sd/examples` on every start.
`watchface.wasm` runs on every profile: it asks the display for its size,
shape and format and uses whatever inputs the device has. Rebuild it with
`clang --target=wasm32-wasip1 --sysroot=<wasi-sysroot> -Ios/wasm-rtos/include
-O2 -o examples/watchface.wasm examples/watchface.c`.

Selecting a program in Tasks shows it in the Inspector: its name from its
metadata, state, memory by kind (linear memory, stack and how much of it was
used, compiled code, kernel), the pins, displays and input devices it owns,
and, when it failed, why and
in which functions. It also shows the fuel the program has spent (the
interpreter's work count, the same on every device), the browser time its
slices took, and its own output. The Console shows every program's stdout
and stderr, each line marked with the task that wrote it; the runtime's
output port delivers them per task. Pausing a program, or the ⇣ button, swaps it out of RAM;
swap images are kept in JavaScript, outside the runtime's memory, and the
program comes back when it runs again.

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

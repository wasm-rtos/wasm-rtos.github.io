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

The simulated device is described as data in `main.js` (`DEVICE_PROFILE`):
the pins the kernel lends to programs, under the names programs open them by
(`"led"`, `"button-a"`, `gpio0`…`gpio7`), and the parts wired to them. The
runtime's GPIO port reports what programs drive and what the parts on the
board do, such as a pressed button.

Selecting a program in Tasks shows it in the Inspector: its name from its
metadata, state, memory by kind (linear memory, stack and how much of it was
used, compiled code, kernel), the pins it owns, and, when it failed, why and
in which functions. Pausing a program, or the ⇣ button, swaps it out of RAM;
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

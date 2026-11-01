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

`.github/workflows/build-browser.yml` rebuilds the runtime on every push to the
site sources or the `os/wasm-rtos` submodule, verifies the outputs and commits
the updated runtime files, which GitHub Pages then serves.

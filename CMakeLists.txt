cmake_minimum_required(VERSION 3.20)

# This is an orchestration project: the actual compiler is emcc/em++,
# invoked through the 7-Zip source tree's own `make`-based build system, not
# through CMake's native compiler machinery. Hence `project(... NONE)`.
project(sevenzip_wasm NONE)

include(ExternalProject)

find_program(EMCC_EXECUTABLE emcc)
find_program(EMMAKE_EXECUTABLE emmake)
if(NOT EMCC_EXECUTABLE OR NOT EMMAKE_EXECUTABLE)
    message(FATAL_ERROR
        "emcc/emmake not found on PATH. This project must be configured with "
        "an active Emscripten SDK environment: run "
        "`source <emsdk>/emsdk_env.sh` (after `emsdk install <version> && "
        "emsdk activate <version>`) before invoking cmake. See README.md.")
endif()

execute_process(COMMAND "${EMCC_EXECUTABLE}" --version
    OUTPUT_VARIABLE EMCC_VERSION_OUTPUT
    ERROR_QUIET)
string(REGEX MATCH "[0-9]+\\.[0-9]+\\.[0-9]+" EMCC_VERSION "${EMCC_VERSION_OUTPUT}")
message(STATUS "Using emcc ${EMCC_VERSION} (${EMCC_EXECUTABLE})")

set(SEVENZIP_VERSION "2602" CACHE STRING "7-Zip source version to build (as it appears in the release filename)")
set(SEVENZIP_SRC_URL
    "https://github.com/ip7z/7zip/releases/download/26.02/7z${SEVENZIP_VERSION}-src.7z"
    CACHE STRING "URL of the 7-Zip source .7z archive")
set(SEVENZIP_SRC_SHA256
    "c7502dd4557481f52ccf1b3e680329f1fdd207e79a25544afeb3106325474944"
    CACHE STRING "Expected SHA256 of the 7-Zip source archive")

set(SEVENZIP_SOURCE_DIR "${CMAKE_BINARY_DIR}/7z-src")
set(SEVENZIP_ALONE7Z_DIR "${SEVENZIP_SOURCE_DIR}/CPP/7zip/Bundles/Alone7z")
set(SEVENZIP_OUTPUT_DIR "${CMAKE_BINARY_DIR}/dist")
file(MAKE_DIRECTORY "${SEVENZIP_OUTPUT_DIR}")

# CMake's file(ARCHIVE_EXTRACT), backed by libarchive, can read the 7z format
# on modern libarchive builds -- verified with a standalone spike against
# this exact archive during development. If your local CMake/libarchive
# predates 7z read support, ExternalProject's URL+extract step below will
# fail with an "unrecognized archive format"-style error; in that case,
# install `7z`/`7zr`/`p7zip` and extract SEVENZIP_SRC_URL manually into
# SEVENZIP_SOURCE_DIR, then re-run cmake with -DFETCHCONTENT_FULLY_DISCONNECTED=ON
# equivalent (i.e. skip the download step) -- see README.md.

set(SEVENZIP_ASYNCIFY_IMPORTS "['__syscall_openat','__syscall_mkdirat']")
set(SEVENZIP_RUNTIME_METHODS "['FS','callMain','ccall']")
# -sNO_DISABLE_EXCEPTION_CATCHING: 7-Zip's own extraction code relies on
# catching C++ exceptions it throws itself (e.g. tolerating EEXIST while
# creating nested directories) -- Emscripten disables catching by default,
# which turns any such exception into a hard abort instead of a handled
# error path. -sASYNCIFY_STACK_SIZE: the default (4096) is too small for
# 7-Zip's call depth at the point our async OPFS syscalls suspend; too small
# a value fails as a wasm "unreachable" trap, not a clean error. Both were
# found empirically to be required -- see the risks section in the plan.
set(SEVENZIP_LDFLAGS_EMCC
    "-O2 -sNO_DISABLE_EXCEPTION_CATCHING -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=131072 -sASYNCIFY_IMPORTS=${SEVENZIP_ASYNCIFY_IMPORTS} -sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=SevenZip -sEXPORTED_RUNTIME_METHODS=${SEVENZIP_RUNTIME_METHODS} --js-library ${CMAKE_SOURCE_DIR}/src-glue/opfs_fs.js --pre-js ${SEVENZIP_ALONE7Z_DIR}/pre.js --post-js ${SEVENZIP_ALONE7Z_DIR}/post.js")

ExternalProject_Add(sevenzip_src
    URL                 "${SEVENZIP_SRC_URL}"
    URL_HASH            "SHA256=${SEVENZIP_SRC_SHA256}"
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
    DOWNLOAD_DIR        "${CMAKE_BINARY_DIR}/download"
    SOURCE_DIR          "${SEVENZIP_SOURCE_DIR}"
    # `git apply` resolves patch paths relative to the enclosing repo's
    # toplevel (found by walking up from cwd), not relative to cwd itself --
    # this bites us because SEVENZIP_SOURCE_DIR normally lives inside this
    # project's own git working tree. A throwaway `git init` here makes
    # SEVENZIP_SOURCE_DIR itself the toplevel, so paths resolve correctly
    # regardless of where the build directory sits.
    PATCH_COMMAND       git init -q .
                COMMAND git apply --ignore-whitespace "${CMAKE_SOURCE_DIR}/patches/7zz-emcc.patch"
    CONFIGURE_COMMAND   ""
    BUILD_IN_SOURCE     TRUE
    BUILD_COMMAND       "${EMMAKE_EXECUTABLE}" make -j
                            -C "${SEVENZIP_ALONE7Z_DIR}"
                            -f makefile.emcc
                            "ST_MODE=1"
                            "LDFLAGS_EMCC=${SEVENZIP_LDFLAGS_EMCC}"
    INSTALL_COMMAND     "${CMAKE_COMMAND}" -E copy
                            "${SEVENZIP_ALONE7Z_DIR}/_o/7zz.js"
                            "${SEVENZIP_ALONE7Z_DIR}/_o/7zz.wasm"
                            "${SEVENZIP_OUTPUT_DIR}/"
    BUILD_BYPRODUCTS    "${SEVENZIP_OUTPUT_DIR}/7zz.js"
                        "${SEVENZIP_OUTPUT_DIR}/7zz.wasm"
    LOG_DOWNLOAD        TRUE
)

# The PROG variable in makefile.emcc is "7zz.js" (see patches/7zz-emcc.patch);
# despite -sEXPORT_ES6=1, emcc still names the primary JS output after PROG
# verbatim rather than rewriting the extension -- verify this against the
# actual build output and adjust makefile.emcc's `PROG` value (e.g. to
# "7zz.mjs") if a future emcc version behaves differently.

add_custom_target(sevenzip_wasm ALL DEPENDS sevenzip_src)

message(STATUS "Build output will be copied to: ${SEVENZIP_OUTPUT_DIR}")

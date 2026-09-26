# Third-party notices

This project is built on other people's work. Each item below is licensed by
its own authors, under its own terms, which apply to that item regardless of
the terms in `LICENSE` — those cover only the original code in this repository.

## The synthesis engine — Apache License 2.0

`src/engine/` is a TypeScript port of **msfa**
(music-synthesizer-for-android), <https://github.com/google/music-synthesizer-for-android>.

    Copyright 2012-2013 Google Inc. (Raph Levien)
    Copyright 2017 Pascal Gauthier (Dexed)

Licensed under the Apache License, Version 2.0. A copy is included at
[`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt); you may also obtain one at
<http://www.apache.org/licenses/LICENSE-2.0>.

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied.

**Statement of changes** (Apache 2.0 §4(b)): every file in `src/engine/` is a
transliteration of the corresponding msfa C++ source into TypeScript. The
changes are those the language forces — 64-bit integer intermediates become
`Math.floor` on doubles, and the Q30 sine-table recurrence is built with
BigInt because it exceeds 2^53. Each file states this in its header.

Behavioural constants corrected against hardware by the Dexed authors reach
this project through msfa's own sources, which Dexed distributes under Apache
2.0 in its `Source/msfa/` tree. No code from the GPL-licensed parts of Dexed
is used here.

## Reading a voice from the FM-1 — MIT

`src/midi/fm1.ts` is a TypeScript port of the 7-bit packing and command
framing from **fm1-read-voice** by Christian Zietz,
<https://github.com/czietz/fm1-read-voice>, which worked out how to read the
current voice back from an M-Vave FM-1.

    Copyright (c) 2026 Christian Zietz

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to
    deal in the Software without restriction, including without limitation the
    rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
    sell copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
    FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
    IN THE SOFTWARE.

## Patch data — CC0 1.0

`public/bundles/` carries the **Yamaha DX7 patch library** compiled by
visualizersdotnl, <https://github.com/visualizersdotnl/Yamaha-DX7-patch-library>,
released into the public domain under CC0 1.0. It appears in the application as
the "DX7 curator standard library"; file paths within it have been shortened,
and nothing else about the patch data has been altered.

## Factory cartridges — Yamaha

`test/fixtures/` holds four Yamaha DX7 factory cartridges (ROM1A, ROM1B, ROM3A,
ROM3B). They are here as test fixtures and nothing else: they are the only
patches in reach whose intended character is documented, so they are the only
place the analysis can be checked against something other than taste. Every test
in `test/` reads them.

They are Yamaha's work, not covered by any of the licences above, and no claim
is made over them. Dumps of these cartridges have circulated freely for decades
and are carried by most DX7 tooling; if Yamaha would rather they were not here,
they will be removed on request.

## Typefaces — SIL Open Font License 1.1

*Chango* (Julieta Ulanovsky) and *Space Mono* (Colophon Foundry) are loaded from
Google Fonts at runtime and are not redistributed in this repository.

## Build tooling

TypeScript (Apache 2.0) and Vite (MIT) are development dependencies. Neither is
redistributed as source; Vite's output is the bundled application.

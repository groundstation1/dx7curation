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

## Patch data — CC0 1.0

`public/bundles/` carries the **Yamaha DX7 patch library** compiled by
visualizersdotnl, <https://github.com/visualizersdotnl/Yamaha-DX7-patch-library>,
released into the public domain under CC0 1.0. It appears in the application as
the "DX7 curator standard library"; file paths within it have been shortened,
and nothing else about the patch data has been altered.

## Typefaces — SIL Open Font License 1.1

*Chango* (Julieta Ulanovsky) and *Space Mono* (Colophon Foundry) are loaded from
Google Fonts at runtime and are not redistributed in this repository.

## Build tooling

TypeScript (Apache 2.0) and Vite (MIT) are development dependencies. Neither is
redistributed as source; Vite's output is the bundled application.

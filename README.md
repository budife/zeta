# Hand Frame → Vector Character

MVP web app: buka webcam, bentuk frame/kotak dengan kedua tangan, dan sebuah **vector character** muncul menempel di wajah yang berada di dalam frame — semua tracking dan rendering berjalan **realtime di browser**, tanpa backend, tanpa AI generatif, tanpa upload gambar.

```
LEFT HAND       RIGHT HAND
    \             /
     \           /
      ┌─────────┐
      │  VECTOR │   ← character SVG menempel di wajah di dalam frame
      └─────────┘
```

---

## Cara install & menjalankan

Butuh Node.js 18+ (diuji pada Node 24) dan browser modern (Chrome/Edge direkomendasikan — butuh SIMD WebAssembly).

```bash
npm install
npm run dev
```

Buka http://localhost:3000, klik **Start Camera**, izinkan akses webcam, lalu angkat kedua tangan dan bentuk kotak.

Langkah `npm install` juga menjalankan `scripts/setup-medapipe.mjs` (postinstall) yang:

1. menyalin runtime WASM MediaPipe dari `node_modules/@mediapipe/tasks-vision/wasm` ke `public/mediapipe/wasm`, dan
2. mengunduh model `hand_landmarker.task` + `face_landmarker.task` ke `public/models/`.

Sehingga aplikasi tidak bergantung pada CDN saat runtime. Ulangi dengan `npm run setup:mediapipe` bila perlu.

> Kamera butuh konteks aman (HTTPS atau `localhost`). `localhost` sudah aman secara default.

### Script lain

| Perintah | Keterangan |
| --- | --- |
| `npm run dev` | Mode development |
| `npm run build` | Build produksi |
| `npm run start` | Jalankan build produksi |
| `npm run test:logic` | Cek logika hand-frame / hysteresis / quad / smoothing / clip-path (tanpa browser) |
| `npm run setup:mediapipe` | Unduh ulang aset MediaPipe |

---

## Struktur folder

```
app/
  layout.tsx          Root layout + metadata
  page.tsx            Halaman utama: menyusun stage, controls, status
  globals.css         Seluruh styling (dark, modern, minimal)
components/
  CameraView.tsx      Elemen <video> + lifecycle kamera + placeholder Start
  HandFrame.tsx       Outline window (candidate rect + polygon aktif) + corner marker
  MediaLayer.tsx      Media full-screen yang di-clip sesuai window (clip-path)
  HandTracker.tsx     Layer debug: skeleton tangan (21 landmark)
  FaceTracker.tsx     Layer debug: face bounding box + landmark
  RegionTracker.tsx   Layer debug: kotak + label region terklasifikasi (berwarna)
  DebugOverlay.tsx    Panel debug (FPS, ukuran, state, region) + menyusun layer debug
  StatusPanel.tsx     Status kecil: Camera / Hands / Frame / Face / Region / Confidence / Media
hooks/
  useHandFrameEngine.ts  Bind engine ke React (status = state, snapshot = DOM)
lib/
  engine.ts           SATU-satunya pemilik realtime loop (requestAnimationFrame)
  handFrame.ts        detectHandFrame() / calculateFrame() / isValidFrame() / isValidQuad()
  regions.ts          Klasifikasi region badan (pose+face landmarks) + hysteresis advanceRegion()
  regionMapping.ts    Map region → transform media (scale/rotate, transform-origin)
  templateRegions.ts  Posisi tiap region di dalam template.svg (satu-satunya tempat tuning)
  faceTracking.ts     Face bounding box + faceInSelection()
  smoothing.ts        RectSmoother + CornerSmoother (interpolation anti-jitter)
  geometry.ts         Utilitas geometri + konstanta tuning FRAME_CONFIG
  stage.ts            Konversi koordinat video → koordinat stage (mirror) + clipPathPolygon()
  types.ts            Tipe shared
public/
  vectors/template.svg  Media default yang ditampilkan melalui window
  vectors/character-*.svg  Sisa asset lama (tidak dipakai, boleh dihapus)
  models/             Model MediaPipe (diunduh saat postinstall), termasuk pose_landmarker.task
  mediapipe/wasm/     Runtime WASM MediaPipe (disalin saat postinstall)
scripts/
  setup-medapipe.mjs  Setup aset MediaPipe
  run-logic-tests.mjs Runner untuk test:logic
  test-logic.mts      Cek logika pipeline
```

---

## Media yang ditampilkan melalui window

Default: `public/vectors/template.svg`. Untuk menggantinya, **klik tombol "Upload Media"** saat kamera aktif — tidak perlu mengubah kode apa pun.

Format yang didukung (semua yang bisa dirender browser):

- Gambar: SVG, PNG, JPG/JPEG, WEBP, GIF (GIF tetap animasi)
- Video: MP4, WebM (tetap playing, loop, muted)

File yang diunggah menjadi media aktif secara instan (object URL lokal, tidak ada upload ke server). Tombol **"Use Template"** muncul untuk kembali ke `template.svg`.

Media selalu full-screen dengan `object-fit: cover`, jadi:

- gambar/video **tidak dikecilkan** untuk masuk ke frame,
- frame tangan adalah **jendela** — hanya bagian media di dalam frame yang terlihat,
- menggeser/miringkan/melebarkan frame mengubah bagian media yang terlihat, realtime.

### Mengganti default

Ganti `public/vectors/template.svg` dengan file Anda sendiri (pertahankan nama file), atau ubah `DEFAULT_MEDIA` di `app/page.tsx`.

### Karakter SVG lama

`public/vectors/character-01.svg … character-10.svg` adalah asset dari versi sebelumnya (sistem 10 character) dan **tidak lagi dipakai**. Aman untuk dihapus.

---

## Debug mode

Tombol **Debug ON/OFF** di kanan atas. Default **OFF**.

Saat aktif:

- skeleton tangan (21 landmark per tangan, ujung jari disorot),
- face bounding box + sampel landmark wajah,
- pose landmark (33 titik) + kotak & label region terklasifikasi (hijau, dengan persentase confidence),
- 4 corner marker frame,
- panel kiri-atas: **FPS**, jumlah tangan, ukuran video, jumlah corner, dimensi & rotasi frame, jumlah landmark wajah, jumlah pose landmark, **Region** (mis. "Eyes", "Torso"), **Confidence**, **Selection** (x/y/lebar/tinggi/rotasi), **Template** (koordinat box region di template.svg), jumlah corner window, dan state deteksi.

### Dua alat bantu tambahan

**`http://localhost:3000/?cpu=1`** — memaksa delegate CPU (XNNPACK) untuk model tangan dan wajah, melewati fallback GPU. Berguna bila inferensi WebGL diam-diam menghasilkan hasil kosong alih-alih melempar error, atau saat mendebug di browser headless. Tanpa parameter ini perilakunya normal: coba GPU dulu, fallback ke CPU.

**`window.__handFrameDebug`** — hook diagnostik yang ditulis `lib/engine.ts` setiap frame, hanya untuk inspeksi via Console/CDP:

```js
const d = window.__handFrameDebug;
d.handLandmarkCount   // jumlah tangan terdeteksi
d.rawHandLandmarks    // 21 landmark × 2 tangan (koordinat ternormalisasi)
d.detection.reason    // "hands-not-detected" | "one-hand-detected" |
                      // "gesture-invalid" | "corners-found"
d.detection.gestures  // verdict gesture per tangan + alasannya
d.validity            // hasil isValidQuad(): { valid, reason }
d.snapshot            // snapshot lengkap yang dikirim ke komponen
d.snapshot.windowCorners // 4 corner window yang sudah di-smooth (kosong = frame inactive)
```

`snapshot.reason` sangat membantu untuk tahu **kenapa** frame tidak aktif — misalnya `"too-narrow"` berarti window terlalu sempit, atau `"not-simple-quad"` berarti corner saling menyilang (bowtie).

---

## Bagaimana hand-frame detection bekerja

Pipeline berjalan dalam satu `requestAnimationFrame` di `lib/engine.ts`. Hanya frame baru dari kamera yang diproses (`video.currentTime` berubah), jadi tidak ada CPU yang terbuang saat browser menampilkan lebih banyak frame daripada kamera.

### 1. Deteksi tangan — MediaPipe Hands

`@mediapipe/tasks-vision` `HandLandmarker` (model `hand_landmarker.task`, mode `VIDEO`, `numHands: 2`). Ini adalah API Tasks yang stabil; paket lama `@mediapipe/hands` sudah deprecated. Memberikan 21 landmark per tangan dalam koordinat ternormalisasi.

### 2. `detectHandFrame()` — memvalidasi gesture dan mengambil 4 corner

Setiap tangan harus membentuk **"L"** (sudut frame):

- telunjuk **terbuka**: jarak ujung telunjuk ↔ MCP-nya > 0.7 × panjang telapak,
- jarak ujung jempol ↔ ujung telunjuk > 0.45 × panjang telapak (kedua jari membentuk sudut),
- minimal **2 dari 3** jari lain (tengah/manis/kelingking) **terlipat**.

Syarat terakhir inilah yang menolak telapak terbuka (false positive) tanpa membuat gesture menjadi presisi. Semua threshold skala-relatif terhadap ukuran telapak, sehingga berfungsi sama baiknya untuk tangan dekat maupun jauh.

Setiap tangan yang valid memberikan **dua corner**: ujung jempol dan ujung telunjuk. Dua tangan → **empat corner**. Corner di-sort secara angular terhadap centroid-nya sehingga selalu membentuk poligon simple. **Tidak ada posisi frame yang di-hardcode** — posisi, ukuran, dan rotasi murni mengikuti tangan.

### 3. `calculateFrame()` — memasang rectangle berorientasi

Karena sisi yang berhadapan sebuah rectangle selalu sejajar, arah sumbu rectangle diambil dari rata-rata arah sisi 0→1 dan sisi **2→3 yang dibalik** (sisi yang berhadapan pada polygon dengan winding konsisten selalu berlawanan arah). Keempat corner diproyeksikan ke sumbu tersebut dan sumbu tegak lurusnya untuk mendapatkan `cx, cy, width, height, rotation`.

### 4. `isValidQuad()` — validasi window (sengaja sangat toleran)

Validasi sekarang berjalan langsung pada **quadrilateral** yang dibentuk ujung jari, bukan pada rectangle yang dipasang. Frame **boleh asimetris, miring, tidak sejajar, atau sedikit trapezoid** — selama empat corner masih membentuk area tertutup yang menyerupai quadrilateral, frame tetap aktif.

| Cek | Batas | Alasan |
| --- | --- | --- |
| Jumlah corner | tepat 4 | frame belum terbentuk |
| Luas (shoelace) | 3.5% – 95% dari luas video | terlalu kecil / terlalu besar |
| Winding | semua corner berbelok ke arah yang sama | `"not-simple-quad"` (corner saling menyilang) |
| Sisi minimum | ≥ 6% dari sisi video terpendek | `"too-narrow"` (sliver) |
| Aspek rasio | ≤ 3.4 : 1 | `"too-narrow"` (mis. satu tangan saja) |

Kemudian ada **hysteresis** agar frame tidak berkedip: perlu **2 frame valid** berturut-turut untuk ACTIVE, dan **4 frame invalid** berturut-turut untuk kembali INACTIVE.

### 5. Face tracking — fitur sekunder

`FaceLandmarker` hanya dijalankan **ketika frame sedang aktif**. Bounding box dihitung dari 478 landmark (dengan padding 6%). `faceInSelection()` memeriksa apakah wajah berada di dalam window, dan box terakhir dipertahankan selama 500 ms saat deteksi berkedip.

**Wajah bukan syarat efek.** Frame valid = media langsung muncul. Face detection hanya mengisi baris "Face" di status panel sebagai indikator pembantu.

### 6. Window rendering — clip-path

Inilah inti perubahan dari versi sebelumnya. Media **full-screen** dipotong sesuai bentuk tangan:

1. `CornerSmoother` menghaluskan keempat corner secara independen (exponential smoothing, τ ≈ 60 ms, **snap instan pada frame pertama**). Karena tiap corner dilacak terpisah, window **tetap bisa trapezoid/asimetris** — tidak ditarik kembali ke rectangle.
2. `clipPathPolygon()` di `lib/stage.ts` mengonversi 4 corner menjadi `polygon(...)` dalam persen stage, dengan mirror.
3. `MediaLayer` menerapkan itu sebagai `clip-path` pada elemen media full-screen (`object-fit: cover`). Media **tidak pernah di-scale masuk frame** — frame adalah jendela, bukan container.
4. `HandFrame` men-reference polygon SVG yang sama persis (`vector-effect: non-scaling-stroke`) sehingga outline selalu sejajar dengan tepi window.

**Mengapa `clip-path` dan bukan canvas compositing:** GPU-accelerated, tidak ada salinan tekstur per frame, dan media apapun (SVG/PNG/GIF/video) langsung bekerja tanpa decoding manual.

### 7. Region mapping — window memilih bagian badan

Selain memotong media, window juga **diklasifikasikan ke bagian tubuh** yang sedang dibingkai. Kalau klasifikasinya yakin, media **tidak menampilkan seluruh gambar** — ia zoom ke region yang cocok (`lib/regionMapping.ts` → `transform: scale() rotate()` + `transform-origin`). Kalau tidak yakin, kembali ke perilaku clipping biasa (media full-screen).

Alurnya per frame (hanya saat frame aktif):

1. **Pose Landmarker** (`models/pose_landmarker.task`, diunduh saat postinstall) mendeteksi 33 landmark tubuh; **Face Landmarker** menyediakan 478 landmark wajah untuk region halus (mata kiri/kanan, wajah).
2. Jendela tangan diubah jadi box normalisasi (`quadToNormBox`) — **koordinat yang sama** dengan landmark, jadi tidak ada hardcoded screen coordinate sama sekali.
3. `classifyRegion()` (`lib/regions.ts`) membandingkan box jendela dengan bounding box tiap region: EYE/FACE/HEAD/NECK/TORSO/ARM/HAND/LEG, kiri/kanan. Skor = campuran coverage + containment + tightness − jarak pusat; **confidence = coverage** (seberapa besar isi jendela benar-benar menempel di region). Jendela yang cuma menempel pinggiran → confidence rendah → fallback clipping.
4. **Hysteresis / region lock** (`advanceRegion()`): incumbent hanya berganti kalau challenger menang telak (margin ≥ 0.12), confidence dihaluskan pakai EMA (τ 250 ms), dan di bawah 0.25 region di-reset. Ini yang mencegah flicker EYE→FACE→HEAD dan "bintik" confidence di debug panel.
5. Hasilnya masuk `Snapshot.region` + `Snapshot.regionTransform`; `MediaLayer` menerapkannya. Debug ON → `RegionTracker` menggambar kotak hijau + label `Nama Region NN%`.

Region yang tersedia: `left-eye`, `right-eye`, `eyes`, `face`, `head`, `neck`, `torso`, `left-arm`, `right-arm`, `left-hand`, `right-hand`, `left-leg`, `right-leg`.

**Tuning tanpa menyentuh tracking:** `lib/templateRegions.ts` berisi posisi tiap region di dalam `template.svg` (viewBox `0 0 1100 620`). Angka di sana adalah estimasi pertama untuk artwork placeholder — ubah kotaknya sesuai artwork Anda dan mapping langsung berubah.

Catatan: pose hanya dijalankan saat frame aktif. Bila model pose gagal dimuat, region dibatasi ke wajah/mata dan sisanya tetap clipping biasa (tidak error).

Preview dibalik horizontal (selfie view). Karena itu setiap koordinat overlay dikonversi di `lib/stage.ts` dengan `mirrorX(x) = 1 - x`, dan rotasi dibalik tanda negatifnya. Reflection membalik arah rotasi — ini bukan detail kecil, kalau salah, rectangle akan miring ke arah yang berlawanan.

---

## Performa

- Satu `requestAnimationFrame` loop tunggal — bukan satu loop per komponen.
- Hanya memproses frame yang benar-benar baru dari kamera.
- Face detection dan pose detection hanya berjalan saat frame aktif.
- Nilai per-frame (clip-path, posisi corner) **ditulis langsung ke DOM lewat refs** — React tidak pernah re-render 60 fps. Hanya status diskrit (Camera/Hands/Frame/Face/Region/Confidence/Media) yang masuk ke state, dan hanya saat berubah (confidence di-threshold 0.02).
- Delegate GPU digunakan lebih dulu, fallback otomatis ke CPU bila WebGL tidak tersedia.
- Semua tracking client-side. **Tidak ada gambar kamera yang dikirim ke server.**

---

## Yang TIDAK ada di MVP ini (sesuai permintaan)

Login, database, backend, AI generatif, authentication, payment, dan deployment configuration yang kompleks — semuanya tidak ada. Fokus: webcam realtime + hand frame sebagai clipping window + media full-screen.

## Browser support

Chrome/Edge/Firefox terbaru dengan SIMD WASM. Safari mendukung `getUserMedia`, tapi stabilitas MediaPipe WASM SIMD bisa bervariasi.

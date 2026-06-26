# Panduan Penggunaan WA Gateway Web

## Ringkasan
Aplikasi ini adalah panel web untuk menjalankan WhatsApp Gateway, mengelola device, melihat inbox, mengirim pesan, media, stiker, serta memantau log webhook dan histori pesan.

## Panduan Install di VPS aaPanel

Bagian ini adalah jawaban untuk kebutuhan deploy di VPS Linux yang memakai aaPanel.

Dokumen ini fokus supaya setup di Linux **pasti work** dengan meminimalkan error umum:
- folder session tidak bisa ditulis (permission)
- Chromium/Chrome tidak ketemu
- database tidak bisa dibuat/migrasi gagal
- service tidak bisa diakses (binding host / reverse proxy / WebSocket)

## Yang Harus Diinstall di VPS

### Wajib
- **Node.js 18 atau lebih baru**
- **NPM**
- **MySQL / MariaDB**
- **PM2** untuk menjalankan service di background
- **Chromium atau Google Chrome** untuk `whatsapp-web.js`

### Disarankan
- Reverse proxy (aaPanel Nginx / Apache) + SSL
- User Linux khusus untuk service (jangan jalan sebagai `root`)

### Kenapa perlu Chrome / Chromium?
`whatsapp-web.js` berjalan di atas browser automation. Walaupun package project ini tidak memakai package `puppeteer` secara eksplisit di `package.json`, runtime WhatsApp Web tetap butuh browser engine Chrome/Chromium yang tersedia di server.

Jadi secara praktis di Linux kamu harus memastikan salah satu ini ada:
- `chromium`
- `chromium-browser`
- `google-chrome`
- `google-chrome-stable`

Selain install browser, kamu juga perlu memastikan **path binary** browser benar, karena auto-detect browser di code lebih condong ke Windows. Di Linux, cara paling aman adalah set `CHROME_PATH` di `.env`.

## Paket Linux yang Umum Dibutuhkan

Untuk Ubuntu / Debian, install paket dasar berikut:

```bash
apt update
apt install -y \
  curl wget git unzip ca-certificates fonts-liberation \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 libcups2 \
  libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 \
  libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
  libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
  libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxshmfence1 \
  libxss1 libxtst6 lsb-release xdg-utils
```

## Install Chromium / Chrome di Linux

### Opsi 1: Chromium

```bash
apt update
apt install -y chromium
```

Path yang sering dipakai:
- `/usr/bin/chromium`
- `/usr/bin/chromium-browser`

### Opsi 2: Google Chrome

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt install -y ./google-chrome-stable_current_amd64.deb
```

Path yang sering dipakai:
- `/usr/bin/google-chrome`
- `/usr/bin/google-chrome-stable`

## Cara Cek Path Browser di Linux

Jalankan salah satu:

```bash
which chromium
which chromium-browser
which google-chrome
which google-chrome-stable
```

Kalau hasilnya ada, itu path yang bisa dipakai.

Yang umum:
- `/usr/bin/google-chrome-stable`
- `/usr/bin/google-chrome`
- `/usr/bin/chromium`
- `/usr/bin/chromium-browser`

## Folder Project di aaPanel

Di aaPanel umumnya project web diletakkan di salah satu path berikut:

- `/www/wwwroot/namadomain`
- `/www/wwwroot/wa-gateway`
- `/www/server/panel/vhost`

Contoh aman:

```text
/www/wwwroot/wa-gateway
```

## Upload / Clone Project

Masuk ke terminal aaPanel atau SSH, lalu:

```bash
cd /www/wwwroot
git clone <repo-anda> wa-gateway
cd /www/wwwroot/wa-gateway
```

Kalau project diupload manual, cukup pastikan semua file berada di folder project tersebut.

Catatan:
- Jangan upload folder `sessions/` dari Windows ke Linux (biarkan dibuat ulang di server Linux).
- Jangan upload `.env` ke repo publik.

## Install Dependency Project

```bash
cd /www/wwwroot/wa-gateway
npm install

Jika dependency native (misalnya `@parcel/watcher`) gagal build di server, pastikan build tools dan libc sesuai distro.
```

## Konfigurasi Environment

Pastikan file `.env` atau konfigurasi database sudah benar.

Minimal yang perlu benar:
- host database
- port database
- username database
- password database
- nama database
- port aplikasi

### Template `.env` (direkomendasikan untuk Linux)
Sesuaikan nilai-nilainya:

```env
# Production mode
NODE_ENV=production

# Network
HOST=127.0.0.1
PORT=3003
FRONTEND_PORT=3000

# Session login panel (WA SID)
SESSION_SECRET=GANTI_DENGAN_RANDOM_PANJANG

# WA sessions (WA LocalAuth) - WAJIB set untuk Linux agar permission jelas
SESSION_PATH=/www/wwwroot/wa-gateway/sessions

# Browser (WAJIB set untuk Linux)
CHROME_PATH=/usr/bin/google-chrome-stable

# MySQL
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=wa_gateway
DB_PASSWORD=PASSWORDKUAT
DB_NAME=wa_gateway

# Rate limit (WAJIB angka, jangan kosong)
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=1200

# Feature flags
AUTO_REJECT_TYPING=true
AUTO_READ_MESSAGES=false

# Webhook
WEBHOOK_TIMEOUT=10000
WEBHOOK_RETRY=3
WEBHOOK_MESSAGE_DELAY_MS=0
WEBHOOK_MESSAGE_DELAY_OPTIONS=

# Cron (wajib diganti jika fitur blast cron dipakai)
CRON_TOKEN=GANTI_DENGAN_RANDOM_PANJANG
```

Catatan penting:
- Jika kamu pakai reverse proxy Nginx/aaPanel dan SSL, `HOST` sebaiknya `127.0.0.1` (private) dan akses publik lewat domain.
- Jika kamu mau expose langsung port Node ke publik, set `HOST=0.0.0.0` dan pastikan firewall + auth sudah benar.

## Jalankan Migrasi Database

Kalau project memang menjalankan migrasi saat startup, cukup start aplikasi.
Kalau tidak, pastikan tabel berhasil dibuat saat pertama dijalankan.

Setelah update terbaru, tabel `message_logs` sekarang butuh kolom ini juga:
- `mime_type`
- `file_name`
- `media_data`

Jadi setelah deploy update backend, **restart aplikasi** supaya migrasi tambahan ikut jalan.

### Tentang privilege MySQL
Saat startup, service akan menjalankan migrasi (`CREATE DATABASE`, `CREATE TABLE`, dan `ALTER TABLE`). Agar ini berjalan:

- Opsi A (paling mudah): user MySQL punya izin `CREATE` database dan `ALTER` table untuk database target.
- Opsi B (lebih ketat): buat database dulu secara manual sebagai root, lalu berikan izin ke user hanya untuk database tersebut.

Contoh Opsi B (jalankan di MySQL sebagai root/admin):

```sql
CREATE DATABASE IF NOT EXISTS wa_gateway CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'wa_gateway'@'127.0.0.1' IDENTIFIED BY 'PASSWORDKUAT';
GRANT ALL PRIVILEGES ON wa_gateway.* TO 'wa_gateway'@'127.0.0.1';
FLUSH PRIVILEGES;
```

Jika DB-mu tidak boleh dibuat otomatis, gunakan Opsi B.

## Menjalankan Aplikasi

### Kebutuhan
- Node.js `>= 18`
- MySQL aktif
- Dependensi project sudah terinstall dengan `npm install`

### Menjalankan dari terminal / panel IDE
Buka terminal pada folder project lalu jalankan salah satu perintah berikut:

```bash
npm run start:all
```

Untuk mode development:

```bash
npm run dev:all
```

### Permission folder yang WAJIB untuk Linux
Service perlu bisa **create / write / delete** folder berikut:

- `SESSION_PATH` (contoh: `/www/wwwroot/wa-gateway/sessions`)
  - dipakai untuk menyimpan auth WhatsApp (`.wwebjs_auth`)
  - service juga bisa menghapus folder session saat logout/reset device

- Folder upload blast:
  - `public/assets/blast`

Jika permission salah, gejalanya biasanya:
- QR tidak pernah muncul
- status device stuck `connecting`
- error seperti `Cannot prepare WhatsApp session storage...` atau error `EACCES`

Contoh perintah (jalankan di Linux, sesuaikan user yang menjalankan PM2):

```bash
mkdir -p /www/wwwroot/wa-gateway/sessions
mkdir -p /www/wwwroot/wa-gateway/public/assets/blast

# contoh: jika service jalan pakai user www-data
chown -R www-data:www-data /www/wwwroot/wa-gateway/sessions /www/wwwroot/wa-gateway/public/assets/blast
chmod -R 750 /www/wwwroot/wa-gateway/sessions /www/wwwroot/wa-gateway/public/assets/blast
```

### Script yang tersedia
- `npm run start`
  - Menjalankan backend utama
- `npm run start:frontend`
  - Menjalankan frontend/proxy
- `npm run start:all`
  - Menjalankan backend + frontend sekaligus
- `npm run dev:all`
  - Menjalankan backend + frontend dengan `nodemon`

## Menjalankan di Production dengan PM2

Install PM2:

```bash
npm install -g pm2
```

Lalu jalankan:

```bash
cd /www/wwwroot/wa-gateway
pm2 start npm --name wa-gateway -- run start:all
pm2 save
pm2 startup

Catatan:
- Pastikan PM2 berjalan memakai user non-root.
- Setelah `pm2 startup`, ikuti instruksi yang muncul (PM2 biasanya memberi command yang perlu dijalankan sebagai root sekali).
```

Untuk melihat log:

```bash
pm2 logs wa-gateway
```

Untuk restart:

```bash
pm2 restart wa-gateway
```

## Catatan Khusus Chromium / Chrome di VPS

Kalau server Linux minim GUI, browser tetap bisa jalan headless. Yang penting paket dependensinya lengkap.

Kalau nanti kamu menambahkan konfigurasi `puppeteer` / browser path di service, biasanya path Linux yang dipakai adalah salah satu dari berikut:

```text
/usr/bin/chromium
/usr/bin/chromium-browser
/usr/bin/google-chrome
/usr/bin/google-chrome-stable
```

Kalau di code nanti butuh `executablePath`, gunakan salah satu path yang benar-benar ada di server.

## Reverse Proxy di aaPanel

Umumnya frontend panel dibuka lewat domain dan di-proxy ke aplikasi Node.

Contoh alur:
- Domain: `https://wa.domainanda.com`
- Node app: `127.0.0.1:3003`

Di aaPanel:
- buat site/domain
- aktifkan reverse proxy ke `http://127.0.0.1:3003`
- kalau pakai SSL, aktifkan HTTPS

### Penting: WebSocket
Aplikasi memakai WebSocket di path `/ws`. Pastikan reverse proxy mendukung upgrade WebSocket.

Jika kamu pakai Nginx (konsepnya sama di aaPanel), contoh rule yang aman:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000; # frontend.js
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}

location /ws {
  proxy_pass http://127.0.0.1:3000; # frontend.js (proxy ws ke backend)
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

## Akses Web Panel
Setelah aplikasi aktif, buka browser ke alamat panel yang tampil di terminal. Umumnya:

```text
http://localhost:3003
```

Kalau lewat domain aaPanel, hasil akhirnya bisa seperti:

```text
https://wa.domainanda.com
```

## Login Awal
Gunakan akun default berikut jika belum diubah:

- **Admin**
  - Username: `admin`
  - Password: `admin123`
- **CS**
  - Username: `cs`
  - Password: `cs123`
- **Operator**
  - Username: `operator`
  - Password: `operator123`

Catatan keamanan:
- Setelah pertama login, **wajib ganti password** user default.
- Jika panel dibuka ke publik, jangan biarkan kredensial default tetap aktif.

## Menu Utama

### Dashboard
Menampilkan status singkat perangkat, statistik pesan, dan aktivitas terbaru.

### Devices
Digunakan untuk:
- menambah device
- melihat status koneksi
- melihat API key device
- restart / logout device
- aktif/nonaktifkan device
- mengatur webhook per device

### Messages
Panel inbox WhatsApp.

Fitur yang tersedia:
- melihat daftar conversation realtime
- membuka chat aktif
- mengirim pesan teks
- mengirim file lokal
- mengirim stiker dari file gambar
- memilih emoji dari picker
- melihat gambar masuk/keluar
- klik gambar untuk preview dan zoom
- unread badge otomatis hilang saat chat dibuka

#### Cara kirim pesan teks
1. Buka menu `Messages`
2. Pilih conversation di sisi kiri
3. Ketik pesan pada kolom bawah
4. Tekan `Enter` atau klik tombol kirim

#### Cara kirim media lokal
1. Buka conversation
2. Klik tombol lampiran
3. Pilih file dari komputer
4. Tambahkan caption bila perlu
5. Klik tombol kirim

#### Cara kirim stiker
1. Buka conversation
2. Klik tombol lampiran
3. Pilih file gambar
4. Aktifkan tombol mode stiker
5. Klik kirim

#### Cara pilih emoji
1. Klik tombol emoji di area compose
2. Pilih emoji dari panel
3. Emoji akan masuk ke posisi kursor di textarea

#### Preview gambar
- Gambar pada bubble chat bisa diklik
- Akan terbuka modal preview
- Gunakan tombol `+` dan `-` untuk zoom
- Klik `×` untuk menutup preview

### History
Menampilkan histori pesan dari database.

### Logs
Menampilkan:
- webhook delivery logs
- live event logs

### Users
Khusus admin untuk mengelola akun user panel.

### REST API
Dokumentasi endpoint API internal aplikasi.

## Alur Penggunaan Disarankan

### 1. Tambah / cek device
Masuk ke menu `Devices`, pastikan ada device aktif.

### 2. Hubungkan WhatsApp
Jika status belum `ready`:
- buka QR
- scan dengan WhatsApp
- tunggu sampai status `ready`

### 3. Buka inbox
Masuk ke `Messages` untuk melihat percakapan dan pesan masuk realtime.

### 4. Kirim pesan
Gunakan panel kanan pada `Messages` untuk kirim teks, media, atau stiker.

## Catatan Penting
- Jika baru mengubah backend atau database, restart aplikasi.
- Untuk melihat perubahan frontend terbaru, lakukan hard refresh browser:

```text
Ctrl + F5
```

- Media lama yang tersimpan sebelum fitur preview media ditambahkan mungkin belum punya data preview.
- Media baru setelah update akan tampil lebih lengkap di panel `Messages`.
- Setelah update favicon atau aset statis, kadang browser masih cache. Gunakan hard refresh atau buka tab baru.

## Kekurangan Sistem & Keamanan yang Perlu Diperhatikan

- **Password default**
  - User default (`admin/admin123`, `cs/cs123`, `operator/operator123`) berbahaya jika panel dibuka ke publik. Wajib ganti.
- **Endpoint cron blast publik**
  - Ada endpoint `GET /api/cron/blast?token=...`. Wajib set `CRON_TOKEN` kuat dan batasi akses (IP allowlist/firewall).
- **Webhook bisa SSRF**
  - Webhook mengizinkan URL arbitrary dan server akan melakukan request keluar. Batasi siapa yang boleh set webhook dan batasi tujuan webhook.
- **Jangan expose port Node langsung**
  - Disarankan bind `HOST=127.0.0.1` lalu expose via reverse proxy + SSL.
- **DB bisa cepat membesar**
  - Media disimpan base64 ke kolom `message_logs.media_data`. Siapkan retensi/cleanup + backup.
- **Linux butuh permission folder**
  - `SESSION_PATH` dan `public/assets/blast` harus writable oleh user PM2.
- **Chrome path di Linux**
  - Auto-detect browser di code tidak optimal untuk Linux, jadi `CHROME_PATH` sebaiknya selalu diset.

## Checklist Keamanan & Operasional (Disarankan)

### A. Akses jaringan
- Jalankan backend (`PORT`) dan frontend (`FRONTEND_PORT`) hanya di `127.0.0.1` dan expose lewat reverse proxy + SSL.
- Jangan expose MySQL ke publik.

### B. Kredensial
- Ganti password user default (`admin`, `cs`, `operator`).
- Gunakan `SESSION_SECRET` yang random panjang (min 32 char) dan simpan aman.
- Simpan API key device dengan aman.

### C. Webhook (potensi risiko)
Fitur webhook menerima URL dari panel dan akan melakukan HTTP request keluar.
Ini berguna, tapi punya risiko:
- URL yang salah/berbahaya bisa membuat server mengakses resource internal (SSRF).
- Pastikan hanya admin yang bisa set webhook, dan batasi tujuan webhook ke domain/IP yang kamu percaya.

Jika kamu memakai webhook untuk integrasi, disarankan:
- isi field `secret` untuk webhook (agar receiver bisa verifikasi header `X-WA-Signature`).
- gunakan HTTPS untuk endpoint webhook.

### D. Endpoint cron blast (potensi risiko)
Ada endpoint publik `GET /api/cron/blast?token=...` yang sengaja dibuat untuk scheduler.

Wajib:
- ganti `CRON_TOKEN` dari default
- batasi akses endpoint ini (misalnya hanya bisa diakses dari IP server cron kamu via firewall / allowlist reverse proxy)

### E. Penyimpanan data
- `message_logs.media_data` menyimpan base64 media ke database. Database bisa cepat membesar.
- Siapkan strategi backup, retensi, atau cleanup log bila traffic tinggi.

### F. Update dan monitoring
- Monitor log PM2 (`pm2 logs wa-gateway`).
- Gunakan firewall (UFW/iptables) untuk membatasi port yang terbuka.

## Troubleshooting

### WhatsApp tidak mau jalan di VPS Linux
Cek:
- Chrome / Chromium sudah terinstall
- library dependensi browser sudah lengkap
- user process punya izin menulis session
- server punya RAM cukup

Tambahan:
- pastikan `SESSION_PATH` bisa ditulis oleh user yang menjalankan PM2
- pastikan `CHROME_PATH` benar-benar ada (`ls -l /usr/bin/google-chrome-stable` dll)

### Tidak tahu path Chrome di Linux
Jalankan:

```bash
which chromium
which chromium-browser
which google-chrome
which google-chrome-stable
```

### Sudah install Chromium tapi masih gagal
Cek versi:

```bash
chromium --version
google-chrome --version
```

Kalau command tidak ditemukan, berarti path binary belum ada atau paket belum terinstall benar.

### Panel `/messages` loading lama
Coba:
- pastikan backend berjalan
- pastikan device sudah `ready`
- lakukan `Ctrl + F5`
- restart server bila perlu

### Tombol kirim tidak bekerja
Cek:
- conversation sudah dipilih
- device aktif dan terhubung
- tidak ada error di console browser
- backend berjalan normal

### Media / gambar tidak tampil
Cek:
- pesan memang media, bukan log lama
- server sudah direstart setelah update backend
- database sudah mendapat kolom media baru dari migrasi

### QR tidak muncul
Cek status device di menu `Devices`, lalu ulangi init / refresh QR.

Jika tetap tidak muncul:
- cek log untuk error `Cannot prepare WhatsApp session storage` (permission)
- cek log untuk error Chromium missing libs
- cek `CHROME_PATH`

## Saran Operasional
- Gunakan akun `admin` hanya untuk setup dan maintenance
- Gunakan akun `cs` atau `operator` untuk operasional harian
- Simpan API key device dengan aman
- Jangan membagikan session atau kredensial panel ke pihak lain

## File Penting Project
- `server.js`
- `frontend.js`
- `public/index.html`
- `public/views/messages.html`
- `src/routes/api.js`
- `src/services/whatsappService.js`
- `src/db/migrate.js`

## Penutup
Jika setelah update masih ada bagian panel yang tidak berjalan, cek console browser dan log terminal, lalu lakukan restart aplikasi dan refresh browser.

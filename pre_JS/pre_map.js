let currentMapConfig = null;
let mapImage = null;
let mapCanvas, mapCtx;
let mapScale = 1.0;
let mapOffsetX = 0, mapOffsetY = 0;

// 現在地追跡用
let watchId = null;
let currentUserPos = null; // {lat, lon, accuracy}

// ドラッグ操作用変数
let isDragging = false;
let startX, startY;

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Canvas初期化
    mapCanvas = document.getElementById('mapCanvas');
    mapCtx = mapCanvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // 2. イベントリスナー登録 (ドラッグ操作)
    initMapEvents();

    // 3. キャンパス一覧ロード
    await loadMapCampuses();
});

function resizeCanvas() {
    mapCanvas.width = window.innerWidth;
    mapCanvas.height = window.innerHeight;
    if(mapImage) drawMap();
}

// --- キャンパスデータ読み込み ---
async function loadMapCampuses() {
    const select = document.getElementById('mapCampusSelect');
    select.innerHTML = '<option value="">キャンパスを選択...</option>';

    try {
        const snap = await db.collection('campuses').orderBy('order').get().catch(() => db.collection('campuses').get());
        if(snap.empty) return;
        
        let firstCid = null;
        snap.forEach(doc => {
            const d = doc.data();
            const opt = document.createElement('option');
            opt.value = doc.id;
            opt.textContent = d.name;
            select.appendChild(opt);
            if(!firstCid) firstCid = doc.id;
        });
        
        // デフォルトキャンパスを選択
        if (typeof userSettings !== 'undefined' && userSettings.defaultCampusId) {
            select.value = userSettings.defaultCampusId;
            loadCampusMapData(userSettings.defaultCampusId);
        } else if (firstCid) {
            select.value = firstCid;
            loadCampusMapData(firstCid);
        }
    } catch(e) { console.error(e); }
}

async function changeMapCampus() {
    const cid = document.getElementById('mapCampusSelect').value;
    if(cid) loadCampusMapData(cid);
}

async function loadCampusMapData(cid) {
    try {
        const doc = await db.collection('campuses').doc(cid).get();
        if(!doc.exists) return;
        
        const data = doc.data();
        const mapSrc = (data.mapConfig) ? (data.mapConfig.image || data.mapConfig.imageUrl) : null;

        if(mapSrc) {
            currentMapConfig = data.mapConfig;
            
            mapImage = new Image();
            mapImage.onload = () => {
                fitMapToScreen();
                drawMap();
            };
            mapImage.src = mapSrc;
        } else {
            alert("このキャンパスにはマップ画像が設定されていません");
            mapImage = null;
            currentMapConfig = null;
            drawMap();
        }
    } catch(e) { console.error(e); }
}

// --- 描画・操作関連 ---

function fitMapToScreen() {
    if(!mapImage) return;
    const scaleW = mapCanvas.width / mapImage.width;
    const scaleH = mapCanvas.height / mapImage.height;
    mapScale = Math.min(scaleW, scaleH); 
    
    // 中央配置
    mapOffsetX = (mapCanvas.width - mapImage.width * mapScale) / 2;
    mapOffsetY = (mapCanvas.height - mapImage.height * mapScale) / 2;
}

function drawMap() {
    // 画面クリア
    mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    
    // 背景
    mapCtx.fillStyle = "#e0e0e0";
    mapCtx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);

    if(!mapImage) {
        mapCtx.fillStyle = "#666";
        mapCtx.font = "16px sans-serif";
        mapCtx.fillText("マップ画像なし", 20, 50);
        return;
    }

    mapCtx.save();
    
    // 変換マトリクス適用 (移動 -> スケール)
    mapCtx.translate(mapOffsetX, mapOffsetY);
    mapCtx.scale(mapScale, mapScale);
    
    // 地図画像描画
    mapCtx.drawImage(mapImage, 0, 0);

    // 現在地ピンの描画
    if (currentUserPos && currentMapConfig) {
        const pixel = geoToPixel(
            currentUserPos.lat, 
            currentUserPos.lon, 
            currentMapConfig
        );
        
        if (pixel) {
            // ピン描画 (赤丸)
            mapCtx.beginPath();
            mapCtx.arc(pixel.x, pixel.y, 20 / mapScale, 0, Math.PI * 2); // 逆スケールでサイズ維持
            mapCtx.fillStyle = "rgba(0, 123, 255, 0.8)"; // 青
            mapCtx.fill();
            mapCtx.lineWidth = 3 / mapScale;
            mapCtx.strokeStyle = "white";
            mapCtx.stroke();

            // 精度円 (Accuracy) - オプション
            // const radius = (currentUserPos.accuracy / pixel.metersPerPixel);
            // mapCtx.beginPath();
            // mapCtx.arc(pixel.x, pixel.y, radius, 0, Math.PI * 2);
            // mapCtx.fillStyle = "rgba(0, 123, 255, 0.2)";
            // mapCtx.fill();
        }
    }
    
    mapCtx.restore();
}

// --- 座標変換ロジック (LatLon -> Pixel) ---
function geoToPixel(lat, lon, config) {
    if (!config.origin || !config.terminal) return null;

    const origin = config.origin;   // 画像左上 (0,0) の緯度経度
    const term = config.terminal;   // 画像右下 (W,H) の緯度経度
    const rotation = config.rotation || 0; // 時計回り角度
    const imgW = config.imageWidth || mapImage.width;
    const imgH = config.imageHeight || mapImage.height;

    // 1. 緯度経度をメートル座標(相対)に変換
    // ヒュベニの簡易版: 緯度1度≒111319.49m, 経度1度≒111319.49 * cos(lat)
    const M_PER_LAT = 111319.49;
    const radLat = origin.lat * (Math.PI / 180);
    const M_PER_LON = 111319.49 * Math.cos(radLat);

    // 原点(Origin)からの距離 (北がプラスY, 東がプラスX の通常デカルト系で考える)
    // ※ただし地図画像は「南がプラスY」なので、緯度は (origin - current) が正
    // ここではまず「幾何学的なXY平面(北=Y+, 東=X+)」で計算し、あとで回転・反転させる
    
    // Userの相対位置 (メートル)
    const dy_u = (lat - origin.lat) * M_PER_LAT; // 北へ行くとプラス
    const dx_u = (lon - origin.lon) * M_PER_LON; // 東へ行くとプラス

    // Terminalの相対位置 (メートル)
    const dy_t = (term.lat - origin.lat) * M_PER_LAT;
    const dx_t = (term.lon - origin.lon) * M_PER_LON;

    // 2. 回転補正 (-rotation 回転させる)
    // 地図が時計回りに rotation 度 傾いている
    // -> 地図上の座標系に合わせるため、ベクトルを反時計回りに rotation 度 回す
    const rad = -rotation * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const rot_x_u = dx_u * cos - dy_u * sin;
    const rot_y_u = dx_u * sin + dy_u * cos;

    const rot_x_t = dx_t * cos - dy_t * sin;
    const rot_y_t = dx_t * sin + dy_t * cos;

    // 3. スケール計算 (Pixel / Meter)
    // 地図画像上では:
    // Originは (0, 0)
    // Terminalは (imgW, imgH)
    // rot_x_t が imgW に、rot_y_t が -imgH に対応するはず
    // (※ 幾何学Yは北プラス、画像Yは南プラスなので符号反転)

    // 安全のため絶対値でスケール算出
    const scaleX = imgW / Math.abs(rot_x_t);
    const scaleY = imgH / Math.abs(rot_y_t);

    // 4. ピクセル座標算出
    // 画像X座標 = 回転後X * ScaleX
    // 画像Y座標 = 回転後Y * ScaleY * (-1)  <-- Y軸反転
    
    // 補正: Terminalが右下にある前提なので、rot_x_tは正、rot_y_tは負(南)になるはず
    // ユーザー位置もそれに合わせて変換
    
    // X軸: そのまま
    let px = rot_x_u * scaleX;
    // Y軸: 幾何学Y(北+) を 画像Y(南+) に変換 -> マイナス掛ける
    let py = -rot_y_u * scaleY;

    // もしOrigin/Terminalの位置関係が想定(左上/右下)と逆だった場合の符号吸収
    if (rot_x_t < 0) px = -px; 
    if (rot_y_t > 0) py = -py; // Terminalが北にある(Y正)場合、画像YはマイナスになるべきだがHは正なので調整

    return { x: px, y: py, metersPerPixel: 1/scaleX };
}

// --- 現在地取得 ---
function centerToCurrentLocation() {
    if (!navigator.geolocation) {
        alert("GPSが使用できません");
        return;
    }
    
    // 連続取得開始 (まだしていなければ)
    if (!watchId) {
        watchId = navigator.geolocation.watchPosition(
            (pos) => {
                currentUserPos = {
                    lat: pos.coords.latitude,
                    lon: pos.coords.longitude,
                    accuracy: pos.coords.accuracy
                };
                drawMap(); // 位置更新のたびに再描画
                
                // 初回のみ中心に移動
                // (操作性を損なうため、強制センタリングはボタン押下時のみにするロジックも可)
            },
            (err) => console.error(err),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    } else {
        // すでに取得中なら、ボタンを押したときは強制的にその位置を中心に持ってくる
        if (currentUserPos && currentMapConfig) {
            const pixel = geoToPixel(currentUserPos.lat, currentUserPos.lon, currentMapConfig);
            if(pixel) {
                // 画面中心に pixel.x, pixel.y が来るように offset を調整
                mapOffsetX = (mapCanvas.width / 2) - (pixel.x * mapScale);
                mapOffsetY = (mapCanvas.height / 2) - (pixel.y * mapScale);
                drawMap();
            }
        } else {
            alert("現在地を取得中...");
        }
    }
}

function initMapEvents() {
    const start = (x, y) => {
        isDragging = true;
        startX = x - mapOffsetX;
        startY = y - mapOffsetY;
    };
    const move = (x, y) => {
        if(!isDragging) return;
        mapOffsetX = x - startX;
        mapOffsetY = y - startY;
        drawMap();
    };
    const end = () => { isDragging = false; };

    mapCanvas.addEventListener('mousedown', e => start(e.clientX, e.clientY));
    mapCanvas.addEventListener('mousemove', e => move(e.clientX, e.clientY));
    mapCanvas.addEventListener('mouseup', end);
    mapCanvas.addEventListener('mouseleave', end);

    mapCanvas.addEventListener('touchstart', e => {
        if(e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY);
    });
    mapCanvas.addEventListener('touchmove', e => {
        e.preventDefault();
        if(e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY);
    });
    mapCanvas.addEventListener('touchend', end);
}
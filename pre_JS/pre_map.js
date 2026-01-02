let currentMapConfig = null;
let mapImage = null;
let mapCanvas, mapCtx;
let mapScale = 1.0;
let mapOffsetX = 0, mapOffsetY = 0;

// 余白設定 (15%)
const MARGIN_RATIO = 0.15; 

// 現在地追跡用
let watchId = null;
let currentUserPos = null; // {lat, lon, accuracy}
let gpsStatus = 'init'; // 'init' | 'searching' | 'ok' | 'error'
let gpsErrorMessage = "";

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Canvas初期化
    mapCanvas = document.getElementById('mapCanvas');
    mapCtx = mapCanvas.getContext('2d');
    
    // リサイズ時に再計算
    window.addEventListener('resize', () => {
        resizeCanvas();
        fitMapToScreen();
        drawMap();
    });
    resizeCanvas();
    
    // 2. キャンパス一覧ロード
    await loadMapCampuses();
});

function resizeCanvas() {
    mapCanvas.width = window.innerWidth;
    mapCanvas.height = window.innerHeight;
}

// --- キャンパスデータ読み込み ---
async function loadMapCampuses() {
    const select = document.getElementById('mapCampusSelect');
    if(!select) return;
    select.innerHTML = '<option value="">キャンパスを選択...</option>';

    try {
        // orderBy削除（全件取得）
        const snap = await db.collection('campuses').get();
        if(snap.empty) {
            select.innerHTML = '<option value="">キャンパスがありません</option>';
            return;
        }
        
        // order順に並び替え
        const docs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        docs.sort((a, b) => (a.order || 9999) - (b.order || 9999));
        
        let firstCid = null;
        docs.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.name;
            select.appendChild(opt);
            if(!firstCid) firstCid = d.id;
        });
        
        // デフォルトキャンパスを選択
        if (typeof userSettings !== 'undefined' && userSettings.defaultCampusId) {
            select.value = userSettings.defaultCampusId;
            loadCampusMapData(userSettings.defaultCampusId);
        } else if (firstCid) {
            select.value = firstCid;
            loadCampusMapData(firstCid);
        }
    } catch(e) { console.error("Map Load Error:", e); }
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

// --- 描画・計算ロジック (固定表示版) ---

function fitMapToScreen() {
    if(!mapImage) return;

    // 画像サイズ + 15%余白
    const visibleW = mapImage.width * (1 + MARGIN_RATIO * 2);
    const visibleH = mapImage.height * (1 + MARGIN_RATIO * 2);

    // 画面に収まる倍率 (Contain)
    const scaleW = mapCanvas.width / visibleW;
    const scaleH = mapCanvas.height / visibleH;
    mapScale = Math.min(scaleW, scaleH); 
    
    // 画像を画面中央に固定配置
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
        drawMessage("マップ画像なし", "black");
        return;
    }

    mapCtx.save();
    
    // --- 地図画像の描画 ---
    mapCtx.translate(mapOffsetX, mapOffsetY);
    mapCtx.scale(mapScale, mapScale);
    mapCtx.drawImage(mapImage, 0, 0);

    let isInside = false;

    // --- 現在地ピンの描画判定 ---
    if (gpsStatus === 'ok' && currentUserPos && currentMapConfig) {
        const pixel = geoToPixel(
            currentUserPos.lat, 
            currentUserPos.lon, 
            currentMapConfig
        );
        
        if (pixel) {
            // 範囲判定: 画像領域 + 15%余白
            const minX = -mapImage.width * MARGIN_RATIO;
            const maxX = mapImage.width * (1 + MARGIN_RATIO);
            const minY = -mapImage.height * MARGIN_RATIO;
            const maxY = mapImage.height * (1 + MARGIN_RATIO);

            // 有限数値かつ範囲内かチェック
            if (isFinite(pixel.x) && isFinite(pixel.y)) {
                isInside = (pixel.x >= minX && pixel.x <= maxX && pixel.y >= minY && pixel.y <= maxY);

                if (isInside) {
                    // ピンを描画 (サイズ一定)
                    const pinRadius = 15 / mapScale;
                    const lineWidth = 3 / mapScale;

                    mapCtx.beginPath();
                    mapCtx.arc(pixel.x, pixel.y, pinRadius, 0, Math.PI * 2); 
                    mapCtx.fillStyle = "rgba(0, 123, 255, 0.9)"; // 青
                    mapCtx.fill();
                    mapCtx.lineWidth = lineWidth;
                    mapCtx.strokeStyle = "white";
                    mapCtx.stroke();
                }
            }
        }
    }
    
    mapCtx.restore();

    // --- ステータス・メッセージ表示 (画面上部) ---
    if (gpsStatus === 'searching') {
        drawMessage("現在地を取得中...", "#007bff");
    } else if (gpsStatus === 'error') {
        drawMessage(gpsErrorMessage || "位置情報の取得に失敗", "#dc3545");
    } else if (gpsStatus === 'ok') {
        // 取得できているが範囲外の場合
        if (!isInside && currentUserPos) {
            drawMessage("現在地はマップ範囲外です", "rgba(0, 0, 0, 0.7)");
        }
    }
}

// ヘルパー: 上部メッセージ描画
function drawMessage(text, bgColor) {
    mapCtx.save();
    mapCtx.fillStyle = bgColor;
    mapCtx.fillRect(0, 0, mapCanvas.width, 50); // 上部バー
    
    mapCtx.fillStyle = "white";
    mapCtx.font = "bold 16px sans-serif";
    mapCtx.textAlign = "center";
    mapCtx.textBaseline = "middle";
    mapCtx.fillText(text, mapCanvas.width / 2, 25);
    mapCtx.restore();
}

// --- 座標変換ロジック ---
function geoToPixel(lat, lon, config) {
    if (!config.origin || !config.terminal) return null;

    const origin = config.origin;   
    const term = config.terminal;   
    const rotation = config.rotation || 0; 
    
    const imgW = config.imageWidth || (mapImage ? mapImage.width : 1000);
    const imgH = config.imageHeight || (mapImage ? mapImage.height : 1000);

    const M_PER_LAT = 111319.49;
    const radLat = origin.lat * (Math.PI / 180);
    const M_PER_LON = 111319.49 * Math.cos(radLat);

    // 相対距離 (メートル)
    const dy_u = (lat - origin.lat) * M_PER_LAT;
    const dx_u = (lon - origin.lon) * M_PER_LON;

    const dy_t = (term.lat - origin.lat) * M_PER_LAT;
    const dx_t = (term.lon - origin.lon) * M_PER_LON;

    // 回転補正
    const rad = -rotation * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const rot_x_u = dx_u * cos - dy_u * sin;
    const rot_y_u = dx_u * sin + dy_u * cos;

    const rot_x_t = dx_t * cos - dy_t * sin;
    const rot_y_t = dx_t * sin + dy_t * cos;

    // スケール計算 (ゼロ除算対策)
    const absX = Math.abs(rot_x_t);
    const absY = Math.abs(rot_y_t);
    if (absX < 0.1 || absY < 0.1) return null; // 座標設定エラーの可能性

    const scaleX = imgW / absX;
    const scaleY = imgH / absY;

    let px = rot_x_u * scaleX;
    let py = -rot_y_u * scaleY; // Y軸反転

    // 符号補正
    if (rot_x_t < 0) px = -px; 
    if (rot_y_t > 0) py = -py; 

    return { x: px, y: py };
}

// --- 現在地取得 ---
function centerToCurrentLocation() {
    if (!navigator.geolocation) {
        alert("GPSが使用できません");
        return;
    }
    
    const btn = document.querySelector('.gps-btn');
    
    // すでに取得中の場合は何もしない（画面更新のみ）
    if (watchId) {
        drawMap();
        return;
    }

    // 取得開始
    gpsStatus = 'searching';
    if(btn) btn.style.color = "#999"; 
    drawMap(); // ステータス更新のために描画

    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            currentUserPos = {
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                accuracy: pos.coords.accuracy
            };
            gpsStatus = 'ok';
            if(btn) btn.style.color = "#007bff"; 
            drawMap(); 
        },
        (err) => {
            console.error(err);
            gpsStatus = 'error';
            // エラーコードによるメッセージ分岐
            if (err.code === 1) gpsErrorMessage = "位置情報の利用が許可されていません";
            else if (err.code === 2) gpsErrorMessage = "位置情報が取得できません";
            else if (err.code === 3) gpsErrorMessage = "取得がタイムアウトしました";
            else gpsErrorMessage = "エラーが発生しました";

            if(btn) btn.style.color = "red";
            drawMap();
        },
        { 
            enableHighAccuracy: true, 
            timeout: 15000, // タイムアウトを少し長めに設定
            maximumAge: 0 
        }
    );
}
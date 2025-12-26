let currentStream = null;
let isAuthCompleted = false; 
let isDetectingLoop = false;
let myRequestId = null;
let lastDetectedDesc = null;
let missedFrameCount = 0;

async function startUserAuthFlow() {
    if (!currentUser) return alert("ログイン情報なし");
    
    document.getElementById('step-0').classList.remove('active');
    
    if (!navigator.geolocation) return alert("位置情報不可");
    
    // 1. 位置情報で最寄りキャンパス特定
    navigator.geolocation.getCurrentPosition(async (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        
        let nearestCampus = null;
        let minDiv = Infinity;
        
        registeredCampuses.forEach(c => {
            const d = getDistance(lat, lon, c.lat, c.lon);
            if(d < minDiv) { minDiv = d; nearestCampus = c; }
        });
        
        if (!nearestCampus) {
            alert("キャンパスデータが見つかりません。");
            return;
        }

        console.log(`Nearest Campus: ${nearestCampus.name}`);

        // 2. そのキャンパスの時間設定でチェック
        const now = new Date();
        const timeStatus = await checkActivityTimeStatus(now, nearestCampus.id);
        
        if (timeStatus.status === 'out') {
            alert(`現在は ${nearestCampus.name} の活動時間外、または活動日ではありません。`);
            return;
        }
        
        if (timeStatus.status === 'late') {
            isLateAuth = true;
            alert(`【${nearestCampus.name}】\n活動開始から30分以上経過しています。\n「遅刻」として認証を開始します。`);
        } else {
            isLateAuth = false;
        }

        // 3. 認証ステップへ進む
        document.getElementById('step-1').classList.add('active');
        startFaceAuth(currentUser.displayName);

    }, (err) => {
        alert("位置情報の取得に失敗しました: " + err.message);
    });
}

// 日時・特定キャンパスから活動状態を判定
// return: { status: 'ok'|'late'|'out' }
async function checkActivityTimeStatus(date, campusId) {
    const ymd = formatDate(date);
    const ym = ymd.substring(0, 7);
    const day = date.getDay();
    const nowMins = date.getHours() * 60 + date.getMinutes();

    let startTime = "17:00";
    let endTime = "19:40";
    let isActivity = false;

    try {
        // 1. 活動例外 (Activity Exceptions)
        const exId = `${ymd}_${campusId}`;
        const exDoc = await db.collection('activity_exceptions').doc(exId).get();
        
        if (exDoc.exists) {
            const d = exDoc.data();
            startTime = d.start;
            endTime = d.end;
            isActivity = true;
        } else {
            // 2. 月次カレンダー
            const calDoc = await db.collection('calendars').doc(ym).get();
            if (calDoc.exists) {
                const calData = calDoc.data();
                
                // ブロックチェック
                const isBlocked = calData.noActivityDays && calData.noActivityDays.some(n => n.date === ymd && (n.cid === campusId || !n.cid));
                
                if (!isBlocked) {
                    // 曜日設定
                    if (calData.activityDays && calData.activityDays[campusId]) {
                        const setting = calData.activityDays[campusId].find(s => s.day === day);
                        if (setting) {
                            isActivity = true;
                            // 設定があれば上書き
                            if (setting.start) startTime = setting.start;
                            if (setting.end) endTime = setting.end;
                        }
                    }
                }
            }
        }
    } catch(e) { console.error(e); }

    if (!isActivity) return { status: 'out' };

    // 時間比較
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;

    if (nowMins < startMins || nowMins > endMins) return { status: 'out' };
    
    // 遅刻判定 (30分後)
    if (nowMins > startMins + 30) return { status: 'late' };

    return { status: 'ok' };
}

async function startFaceAuth(userName) {
    document.getElementById('userStatus').textContent = "カメラ起動中...";
    isAuthCompleted = false; isDetectingLoop = false;
    try {
        await loadModels();
        const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
        currentStream = stream;
        const video = document.getElementById('userVideo');
        video.srcObject = stream;
        video.onloadedmetadata = () => {
            video.play();
            const canvas = document.getElementById('userCanvas');
            const displaySize = { width: video.videoWidth, height: video.videoHeight };
            faceapi.matchDimensions(canvas, displaySize);
            const detectLoop = async () => {
                if (isAuthCompleted || video.paused) return;
                const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
                const resized = faceapi.resizeResults(detections, displaySize);
                canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
                faceapi.draw.drawDetections(canvas, resized);
                if (resized.length > 0) {
                    isAuthCompleted = true;
                    stopFaceAuth();
                    requestAuth(userName);
                }
                if (!isAuthCompleted) setTimeout(detectLoop, 200);
            };
            detectLoop();
        };
    } catch(e) { alert("カメラエラー"); }
}

function stopFaceAuth() {
    if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
}

async function requestAuth(userName) {
    document.getElementById('step-1').classList.remove('active');
    document.getElementById('step-2').classList.add('active');
    const colors = ['C', 'Y', 'M', 'G'];
    const myCode = [colors[Math.floor(Math.random()*4)], colors[Math.floor(Math.random()*4)], colors[Math.floor(Math.random()*4)], colors[Math.floor(Math.random()*4)]];
    drawHCode(myCode);
    const docRef = await db.collection('auth_requests').add({
        userName: userName, authType: `code,${myCode.join(',')}`,
        status: 'pending', isLate: isLateAuth, requestTimestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
    myRequestId = docRef.id;
}

// ステータス確認完了後
async function checkRequestStatus() {
    if(!myRequestId) return;
    const doc = await db.collection('auth_requests').doc(myRequestId).get();
    const data = doc.data();
    if(data.status === 'approved') {
        document.getElementById('step-2').classList.remove('active');
        document.getElementById('step-3').classList.add('active');
        
        // ★遅刻状態ならフォームへ誘導
        if (data.isLate) {
            const link = document.querySelector('#step-3 a.btn-primary'); // 履歴ボタンを乗っ取る
            link.href = "pre_form.html?type=late";
            link.textContent = "遅刻届を提出する (必須)";
            link.style.backgroundColor = "#ffc107"; // 黄色
            link.style.color = "black";
        }
    } else { alert('まだです'); }
}

function drawHCode(codes) {
    const canvas = document.getElementById('codeCanvas');
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // Flet/Dartコードの基準サイズ
    const baseW = 230;
    const baseH = 170;

    // 比率維持のスケール計算
    const scale = Math.min(w / baseW, h / baseH);
    const dx = (w - (baseW * scale)) / 2;
    const dy = (h - (baseH * scale)) / 2;

    const r = (x, y, rw, rh) => [dx + (x * scale), dy + (y * scale), rw * scale, rh * scale];

    ctx.clearRect(0, 0, w, h);
    
    // 1. 背景 (黒)
    ctx.fillStyle = "#000000";
    ctx.fillRect(...r(0, 0, baseW, baseH));

    // 2. マーカー (赤・青)
    ctx.fillStyle = "#FF0000";
    ctx.fillRect(...r(20, 20, 55, 55));   // 左上
    ctx.fillRect(...r(155, 20, 55, 55));  // 右上
    ctx.fillRect(...r(75, 130, 80, 10));  // 中央下の帯

    ctx.fillStyle = "#0000FF";
    ctx.fillRect(...r(20, 75, 55, 75));   // 左下
    ctx.fillRect(...r(155, 75, 55, 75));  // 右下

    // 3. 黒いストローク (枠線) - Dart版の strokePaint に相当
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2 * scale;
    // x=30, y=30, w=170, h=110 の矩形線
    ctx.strokeRect(...r(30, 30, 170, 110));

    // 4. データエリア背景 (白)
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(...r(40, 40, 150, 90));

    // 5. カラーコード (4色)
    const colorMap = { 'C': '#00FFFF', 'Y': '#FFFF00', 'M': '#FF00FF', 'G': '#00FF00' };
    
    ctx.fillStyle = colorMap[codes[0]]; ctx.fillRect(...r(40, 40, 30, 90));  // 左縦
    ctx.fillStyle = colorMap[codes[1]]; ctx.fillRect(...r(80, 40, 70, 30));  // 上横
    ctx.fillStyle = colorMap[codes[2]]; ctx.fillRect(...r(80, 80, 70, 50));  // 下横
    ctx.fillStyle = colorMap[codes[3]]; ctx.fillRect(...r(160, 40, 30, 90)); // 右縦
}
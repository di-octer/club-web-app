let currentStream = null;
let isAuthCompleted = false; 
let isDetectingLoop = false;
let myRequestId = null;
let lastDetectedDesc = null;
let missedFrameCount = 0;

window.addEventListener('beforeunload', (e) => {
    if (myRequestId) {
        cancelAuthRequest();
        e.returnValue = ''; 
    }
});

async function startUserAuthFlow() {
    if (!currentUser) return alert("ログイン情報なし");
    
    document.getElementById('step-0').classList.remove('active');
    
    // ★修正1: iOS対応のGPSオプション定義
    const geoOptions = {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
    };

    if (!navigator.geolocation) return alert("位置情報不可");
    await loadCampuses(); 
    
    // ★修正2: オプション(geoOptions)を第3引数に渡す
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
            // キャンセル扱いとしてリロード等の処理を入れるか、Step0に戻す
            location.reload(); 
            return;
        }

        console.log(`Nearest Campus: ${nearestCampus.name}`);

        const now = new Date();
        const timeStatus = await checkActivityTimeStatus(now, nearestCampus.id);
        
        if (timeStatus.status === 'out') {
            alert(`【認証エラー】\n現在は ${nearestCampus.name} での活動時間外、\nまたは本日は「活動なし」の日です。\n\n認証を開始できません。`);
            location.reload();
            return;
        }
        
        if (timeStatus.status === 'late') {
            isLateAuth = true;
            alert(`【${nearestCampus.name}】\n活動開始から30分以上経過しています。\n「遅刻」として認証を開始します。`);
        } else {
            isLateAuth = false;
        }

        document.getElementById('step-1').classList.add('active');
        startFaceAuth(currentUser.displayName);

    }, (err) => {
        console.error("GPS Error:", err);
        // エラー詳細を表示
        let msg = "位置情報の取得に失敗しました。";
        if (err.code === 1) msg += "\n(権限が許可されていません)";
        else if (err.code === 3) msg += "\n(タイムアウトしました)";
        alert(msg);
        location.reload();
    }, geoOptions); // ★ここにオプションを追加
}

async function startFaceAuth(userName) {
    document.getElementById('userStatus').textContent = "カメラ起動中...";
    isAuthCompleted = false; isDetectingLoop = false;
    try {
        await loadModels();

        const constraints = {
            video: {
                facingMode: "user",
                width: { ideal: 640 },
                height: { ideal: 480 }
            },
            audio: false
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        currentStream = stream;
        const video = document.getElementById('userVideo');
        
        // ★修正3: 自撮りカメラは鏡のように反転させる (操作の違和感をなくす)
        video.style.transform = "scaleX(-1)";
        
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        video.setAttribute('autoplay', 'true');
        video.muted = true;

        video.onloadedmetadata = () => {
            video.play().catch(e => console.error("Play error:", e));
            
            const canvas = document.getElementById('userCanvas');
            // Canvasも反転させないと枠がズレるため合わせる
            canvas.style.transform = "scaleX(-1)";
            
            const displaySize = { width: video.videoWidth, height: video.videoHeight };
            faceapi.matchDimensions(canvas, displaySize);
            
            const detectLoop = async () => {
                if (isAuthCompleted || video.paused || video.ended) return;
                
                try {
                    const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
                    // ※反転表示していても座標計算は元の映像で行われるため、描画はそのままでOK
                    // ただしCanvasごと反転しているので見た目は合うはず
                    const resized = faceapi.resizeResults(detections, displaySize);
                    const ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    faceapi.draw.drawDetections(canvas, resized);
                    
                    if (resized.length > 0) {
                        isAuthCompleted = true;
                        stopFaceAuth();
                        requestAuth(userName);
                        return;
                    }
                } catch(err) { console.log("Detect error", err); }
                
                if (!isAuthCompleted) setTimeout(detectLoop, 200);
            };
            detectLoop();
        };
    } catch(e) { 
        console.error(e);
        alert("カメラ起動エラー: " + e.message + "\n権限を確認してください。"); 
    }
}

function stopFaceAuth() {
    if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
}

async function requestAuth(userName) {
    document.getElementById('step-1').classList.remove('active');
    
    const step2 = document.getElementById('step-2');
    step2.classList.add('active');
    
    const existingBtn = document.getElementById('cancelAuthBtn');
    if(existingBtn) existingBtn.remove();
    
    const cancelBtn = document.createElement('button');
    cancelBtn.id = 'cancelAuthBtn';
    cancelBtn.textContent = "申請をキャンセルして戻る";
    cancelBtn.className = "btn-danger"; 
    cancelBtn.style.cssText = "margin-top:20px; width:100%; padding:10px; background:#dc3545; color:white; border:none; border-radius:4px;";
    
    cancelBtn.onclick = async () => {
        if(confirm("申請を取り消しますか？")) {
            await cancelAuthRequest();
            alert("申請を取り消しました。");
            location.reload(); 
        }
    };
    
    const btnArea = step2.querySelector('.btn-area') || step2;
    btnArea.appendChild(cancelBtn);

    const colors = ['C', 'Y', 'M', 'G'];
    const myCode = [colors[Math.floor(Math.random()*4)], colors[Math.floor(Math.random()*4)], colors[Math.floor(Math.random()*4)], colors[Math.floor(Math.random()*4)]];
    drawHCode(myCode);
    
    try {
        const docRef = await db.collection('auth_requests').add({
            userName: userName, authType: `code,${myCode.join(',')}`,
            status: 'pending', isLate: isLateAuth, requestTimestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        myRequestId = docRef.id;
    } catch(e) {
        alert("申請エラー: " + e.message);
        location.reload();
    }
}

async function cancelAuthRequest() {
    if (!myRequestId) return;
    try {
        await db.collection('auth_requests').doc(myRequestId).delete();
        myRequestId = null;
    } catch(e) { console.error("Delete Error:", e); }
}

async function checkRequestStatus() {
    if(!myRequestId) return;
    
    try {
        const doc = await db.collection('auth_requests').doc(myRequestId).get();
        if (!doc.exists) {
            // ドキュメントが消えている場合
            alert("申請データが見つかりません。再申請してください。");
            location.reload();
            return;
        }

        const data = doc.data();
        if(data.status === 'approved') {
            document.getElementById('step-2').classList.remove('active');
            document.getElementById('step-3').classList.add('active');
            
            // ★修正4: DOM要素取得の安全化 (フリーズ防止)
            if (data.isLate) {
                const link = document.querySelector('#step-3 a.btn-primary');
                // 要素がある場合のみ書き換える
                if (link) {
                    link.href = "pre_form.html?type=late";
                    link.textContent = "遅刻届を提出する (必須)";
                    link.style.backgroundColor = "#ffc107";
                    link.style.color = "black";
                }
            }
        } else if (data.status === 'rejected') {
             // 拒否された場合
             alert("申請が却下されました。");
             location.reload();
        } else { 
            alert('まだ承認されていません。\n管理者画面を確認してください。'); 
        }
    } catch(e) {
        console.error(e);
        alert("確認エラー: " + e.message);
    }
}

function drawHCode(codes) {
    const canvas = document.getElementById('codeCanvas');
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    const baseW = 230;
    const baseH = 170;

    const scale = Math.min(w / baseW, h / baseH);
    const dx = (w - (baseW * scale)) / 2;
    const dy = (h - (baseH * scale)) / 2;

    const r = (x, y, rw, rh) => [dx + (x * scale), dy + (y * scale), rw * scale, rh * scale];

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000000";
    ctx.fillRect(...r(0, 0, baseW, baseH));

    ctx.fillStyle = "#FF0000";
    ctx.fillRect(...r(20, 20, 55, 55));
    ctx.fillRect(...r(155, 20, 55, 55));
    ctx.fillRect(...r(75, 130, 80, 10));

    ctx.fillStyle = "#0000FF";
    ctx.fillRect(...r(20, 75, 55, 75));
    ctx.fillRect(...r(155, 75, 55, 75));

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2 * scale;
    ctx.strokeRect(...r(30, 30, 170, 110));

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(...r(40, 40, 150, 90));

    const colorMap = { 'C': '#00FFFF', 'Y': '#FFFF00', 'M': '#FF00FF', 'G': '#00FF00' };
    
    ctx.fillStyle = colorMap[codes[0]]; ctx.fillRect(...r(40, 40, 30, 90));
    ctx.fillStyle = colorMap[codes[1]]; ctx.fillRect(...r(80, 40, 70, 30));
    ctx.fillStyle = colorMap[codes[2]]; ctx.fillRect(...r(80, 80, 70, 50));
    ctx.fillStyle = colorMap[codes[3]]; ctx.fillRect(...r(160, 40, 30, 90));
}
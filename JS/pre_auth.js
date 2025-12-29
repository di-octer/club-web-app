let currentStream = null;
let isAuthCompleted = false; 
let isDetectingLoop = false;
let myRequestId = null;
let lastDetectedDesc = null;
let missedFrameCount = 0;

window.addEventListener('beforeunload', (e) => {
    if (myRequestId) {
        // 非同期だがベストエフォートで実行
        cancelAuthRequest();
        e.returnValue = ''; // 確認ダイアログを出す場合
    }
});

async function startUserAuthFlow() {
    if (!currentUser) return alert("ログイン情報なし");
    
    // ★修正: ここにあった「過去の未完了申請を削除する処理」を削除しました。
    // これにより、キャンセルや再試行時に他の申請が勝手に消えるのを防ぎます。

    document.getElementById('step-0').classList.remove('active');
    if (!navigator.geolocation) return alert("位置情報不可");
    await loadCampuses(); 
    
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
            alert(`【認証エラー】\n現在は ${nearestCampus.name} での活動時間外、\nまたは本日は「活動なし」の日です。\n\n認証を開始できません。`);
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

async function startFaceAuth(userName) {
    document.getElementById('userStatus').textContent = "カメラ起動中...";
    isAuthCompleted = false; isDetectingLoop = false;
    try {
        await loadModels();

        // ★修正: スマホ対応のオプション設定
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
        video.srcObject = stream;
        
        // ★重要: iOS/スマホでの再生エラー防止
        video.setAttribute('playsinline', 'true');
        video.setAttribute('autoplay', 'true');
        video.muted = true;

        video.onloadedmetadata = () => {
            video.play().catch(e => console.error("Play error:", e));
            
            const canvas = document.getElementById('userCanvas');
            const displaySize = { width: video.videoWidth, height: video.videoHeight };
            faceapi.matchDimensions(canvas, displaySize);
            
            const detectLoop = async () => {
                if (isAuthCompleted || video.paused || video.ended) return;
                
                try {
                    const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
                    const resized = faceapi.resizeResults(detections, displaySize);
                    const ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    faceapi.draw.drawDetections(canvas, resized);
                    
                    if (resized.length > 0) {
                        // 検出成功
                        isAuthCompleted = true;
                        stopFaceAuth();
                        requestAuth(userName);
                        return; // ループ終了
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
    
    // ★修正: キャンセルボタンを確実に再生成
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
    
    // step2の中に追加 (step2内に .btn-area があればそこへ、なければ末尾へ)
    const btnArea = step2.querySelector('.btn-area') || step2;
    btnArea.appendChild(cancelBtn);

    // ... (以下、申請データ送信処理) ...
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
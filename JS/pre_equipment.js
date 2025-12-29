// pre_equipment.js

let allEquipments = [];

window.addEventListener('load', async () => {
    // 共通パーツのロード待ちなどは pre_common.js が担当
    if(currentUser) {
        await initEquipmentPage();
    } else {
        // ログイン待ち
        auth.onAuthStateChanged(async (user) => {
            if(user) await initEquipmentPage();
        });
    }
});

async function initEquipmentPage() {
    await loadEquipments();
    loadMyEqRequests();
    renderEqStatusList();
}

function switchEqTab(tabName) {
    document.getElementById('tab-request').style.display = tabName === 'request' ? 'block' : 'none';
    document.getElementById('tab-list').style.display = tabName === 'list' ? 'block' : 'none';
    
    document.querySelectorAll('.tab-btn').forEach((btn, idx) => {
        if((tabName === 'request' && idx === 0) || (tabName === 'list' && idx === 1)) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// 備品マスタ読み込み
// 備品マスタ読み込み
async function loadEquipments() {
    const select = document.getElementById('eqSelect');
    if(!select) return;
    
    select.innerHTML = '<option value="">読み込み中...</option>';
    
    try {
        const snap = await db.collection('equipments').orderBy('name').get();
        allEquipments = [];
        let html = '<option value="">選択してください</option>';
        
        snap.forEach(doc => {
            const d = doc.data();
            allEquipments.push({ id: doc.id, ...d });

            // キャンパス名の解決 (registeredCampusesを利用)
            let cName = "場所不明";
            if (typeof registeredCampuses !== 'undefined') {
                const c = registeredCampuses.find(x => x.id === d.campusId);
                if (c) cName = c.name;
            } else {
                // 万が一ロード前の場合のフォールバック (ID表示)
                cName = d.campusId;
            }

            // ★修正: 備品名(受け取りキャンパス名) の形式に変更
            html += `<option value="${doc.id}">${d.name} (${cName})</option>`;
        });
        select.innerHTML = html;
    } catch(e) {
        console.error(e);
        select.innerHTML = '<option value="">読み込みエラー</option>';
    }
}

// 選択時のチェック (貸出中なら日付制限)
function checkEqAvailability() {
    const eqId = document.getElementById('eqSelect').value;
    const infoMsg = document.getElementById('eqInfoMsg');
    const startInput = document.getElementById('eqStartDate');
    const endInput = document.getElementById('eqEndDate');
    
    startInput.value = "";
    endInput.value = "";
    startInput.min = ""; 
    
    if (!eqId) {
        infoMsg.textContent = "";
        return;
    }

    const item = allEquipments.find(e => e.id === eqId);
    if (!item) return;

    let msg = `受取場所: ${getCampusName(item.campusId)}`;
    if (item.maxDuration) msg += ` / 貸出可能期間: 最大${item.maxDuration}日`;

    // 現在貸出中かどうかチェック
    if (item.status === 'loaned' && item.currentLoan && item.currentLoan.endDate) {
        const endDate = item.currentLoan.endDate.toDate(); // Timestamp -> Date
        const nextAvailable = new Date(endDate);
        nextAvailable.setDate(nextAvailable.getDate() + 1); // 返却翌日から可
        
        const ymd = formatDate(nextAvailable);
        startInput.min = ymd;
        
        msg += `\n【現在貸出中】${formatDate(endDate)}まで貸出されています。${ymd}以降を選択してください。`;
        infoMsg.style.color = "#dc3545"; // 赤字
    } else {
        // 利用可能なら今日以降
        startInput.min = formatDate(new Date());
        infoMsg.style.color = "#666";
    }
    
    infoMsg.innerText = msg;
}

// 日付変更時のバリデーション (最大日数チェック)
function validateEqDates() {
    const eqId = document.getElementById('eqSelect').value;
    const startVal = document.getElementById('eqStartDate').value;
    const endVal = document.getElementById('eqEndDate').value;
    
    if (!eqId || !startVal || !endVal) return;

    const item = allEquipments.find(e => e.id === eqId);
    const startDate = new Date(startVal);
    const endDate = new Date(endVal);

    // 終了日が開始日より前
    if (endDate < startDate) {
        alert("終了日は開始日よりあとに設定してください");
        document.getElementById('eqEndDate').value = "";
        return;
    }

    // 最大日数チェック
    if (item && item.maxDuration) {
        const diffTime = endDate - startDate;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; // 当日含む
        
        if (diffDays > parseInt(item.maxDuration)) {
            alert(`この備品は最大 ${item.maxDuration} 日間までしか借りられません。`);
            document.getElementById('eqEndDate').value = "";
        }
    }
}

// 申請送信
async function submitEqRequest() {
    const eqId = document.getElementById('eqSelect').value;
    const startVal = document.getElementById('eqStartDate').value;
    const endVal = document.getElementById('eqEndDate').value;

    if (!eqId || !startVal || !endVal) return alert("すべての項目を入力してください");

    if(!confirm("この内容で申請しますか？")) return;

    try {
        const item = allEquipments.find(e => e.id === eqId);
        
        await db.collection('equipment_requests').add({
            userId: currentUser.uid,
            userName: currentUser.displayName || "NoName",
            equipmentId: eqId,
            equipmentName: item ? item.name : "不明",
            startDate: firebase.firestore.Timestamp.fromDate(new Date(startVal)),
            endDate: firebase.firestore.Timestamp.fromDate(new Date(endVal)),
            status: 'pending',
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });

        alert("申請しました。管理者承認をお待ちください。");
        document.getElementById('eqSelect').value = "";
        document.getElementById('eqStartDate').value = "";
        document.getElementById('eqEndDate').value = "";
        checkEqAvailability(); // リセット
        loadMyEqRequests(); // 履歴更新

    } catch(e) {
        console.error(e);
        alert("申請エラー: " + e.message);
    }
}

// 自分の履歴表示 (修正版: インデックスエラー回避)
async function loadMyEqRequests() {
    const div = document.getElementById('myEqHistory');
    if (!div) return; // 安全対策

    try {
        // ★修正: orderByとlimitを削除し、whereのみにする
        // (複合インデックス未作成によるエラーを回避するため)
        const snap = await db.collection('equipment_requests')
            .where('userId', '==', currentUser.uid)
            .get();
        
        if(snap.empty) {
            div.innerHTML = "<p>履歴はありません</p>";
            return;
        }

        // 1. データを配列に変換
        const requests = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // 2. JS側でタイムスタンプ降順（新しい順）にソート
        requests.sort((a, b) => {
            const t1 = a.timestamp ? a.timestamp.toMillis() : 0;
            const t2 = b.timestamp ? b.timestamp.toMillis() : 0;
            return t2 - t1; 
        });

        // 3. 最新の5件だけを取り出す
        const recentRequests = requests.slice(0, 5);

        let html = "";
        recentRequests.forEach(d => {
            let statusText = "申請中";
            let color = "#ffc107"; // 黄色
            if(d.status === 'approved') { statusText = "承認済(貸出中)"; color = "#28a745"; } // 緑
            if(d.status === 'rejected') { statusText = "却下"; color = "#dc3545"; } // 赤
            if(d.status === 'returned') { statusText = "返却済"; color = "#666"; }   // グレー

            // 日付フォーマットの安全な処理
            let sDate = "---";
            let eDate = "---";
            try {
                if(d.startDate) sDate = d.startDate.toDate().toLocaleDateString();
                if(d.endDate) eDate = d.endDate.toDate().toLocaleDateString();
            } catch(e) {}

            html += `
                <div class="eq-card" style="border-left: 5px solid ${color};">
                    <div style="font-weight:bold;">${d.equipmentName || '不明な備品'}</div>
                    <div style="font-size:0.9em;">期間: ${sDate} 〜 ${eDate}</div>
                    <div style="font-size:0.9em;">状態: <span style="color:${color};font-weight:bold;">${statusText}</span></div>
                </div>
            `;
        });
        div.innerHTML = html;

    } catch(e) {
        console.error(e);
        div.innerHTML = "<p>読み込みエラーが発生しました</p>";
    }
}

// 一覧タブの表示
function renderEqStatusList() {
    const container = document.getElementById('eqListContainer');
    let html = "";
    
    if(allEquipments.length === 0) {
        html = "<p>備品がありません</p>";
    } else {
        allEquipments.forEach(item => {
            const isLoaned = (item.status === 'loaned');
            const statusLabel = isLoaned ? "貸出中" : "貸出可";
            const badgeClass = isLoaned ? "status-loaned" : "status-available";
            
            let dateInfo = "";
            if (item.maxDuration) dateInfo += `最大${item.maxDuration}日 `;
            if (isLoaned && item.currentLoan && item.currentLoan.endDate) {
                dateInfo += `<br><small>返却予定: ${formatDate(item.currentLoan.endDate.toDate())}</small>`;
            }

            html += `
                <div class="eq-card">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div style="font-weight:bold; font-size:1.1em;">${item.name}</div>
                        <span class="eq-status-badge ${badgeClass}">${statusLabel}</span>
                    </div>
                    <div style="margin-top:5px; font-size:0.9em; color:#555;">
                        キャンパス: ${getCampusName(item.campusId)}<br>
                        ${dateInfo}
                    </div>
                </div>
            `;
        });
    }
    container.innerHTML = html;
}

function getCampusName(cid) {
    const c = registeredCampuses.find(x => x.id === cid);
    return c ? c.name : "不明";
}
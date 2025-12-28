let tempEvents = [];
let tempAcadFestivals = [];
let tempAcadExceptions = [];
let tempNoActivityDays = [];
let adminGuideLoopId = null;
let adminAuthStep = 0;
let currentAuthUser = null;
let colorMatchCounter = 0;
let regStream = null;
let regStep = 0;
let regDescriptors = [];
let regThumbnail = "";
let currentDetection = null;
let faceStableCount = 0;
const REG_INSTRUCTIONS = ["", "正面を向いてください", "顔を【左】に向けてください", "顔を【右】に向けてください", "顔を【上】に向けてください", "顔を【下】に向けてください"];

async function initAdminPage() {
    await loadModels(); 
    await loadRegisteredFaces(); 
    await loadAdminRecommendedArticles(); 
    await populateRegUserSelect(); 
    await populateCampusSelects(); 
    
    // ★追加: 備品管理エリアの描画
    renderEquipmentManagement();

    // デフォルトで「auth」タブではなく「status」タブなどを開く場合はここを変更
    // 今回はHTML側で初期activeクラスがついているタブを開くように switchTab を呼ぶのが無難ですが、
    // 既存コードに合わせて auth タブを開くか、statusタブを開くか調整してください。
    // ここではHTMLの構成に合わせて、ステータスタブを初期表示とします。
    switchTab('status', document.querySelector('.tab-btn.active'));
    
    populateInfoLists();
    
    // 現在設定の自動ロード
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const acadY = (m >= 4) ? y : y - 1;
    const acadInput = document.getElementById('acadYear');
    if(acadInput) { acadInput.value = acadY; loadAcademicConfigByYear(); }
    const tmInput = document.getElementById('targetMonth');
    if(tmInput) { tmInput.value = `${y}-${String(m).padStart(2,'0')}`; loadMonthConfig(); }
}

async function loadAcademicConfigByYear() {
    const y = document.getElementById('acadYear').value;
    if(!y || y.length < 4) return;
    
    // リスト初期化
    tempAcadFestivals = [];
    tempAcadExceptions = [];
    renderAcadTempLists();

    // 入力欄リセット
    const inputs = document.querySelectorAll('.acad-date');
    inputs.forEach(i => i.value = "");

    try {
        const doc = await db.collection('calendar_meta').doc(`config_${y}`).get();
        if(doc.exists) {
            const d = doc.data();
            
            // 期間データの復元
            if(d.periods) {
                if(d.periods.reg1) setValRange('p_reg_1', d.periods.reg1);
                if(d.periods.reg2) setValRange('p_reg_2', d.periods.reg2);
                if(d.periods.sup1) setValRange('p_sup_1', d.periods.sup1);
                if(d.periods.sup2) setValRange('p_sup_2', d.periods.sup2);
                if(d.periods.exam1) setValRange('p_exam_1', d.periods.exam1);
                if(d.periods.exam2) setValRange('p_exam_2', d.periods.exam2);
                if(d.periods.grade1) setValRange('d_grade_1', d.periods.grade1);
                if(d.periods.grade2) setValRange('d_grade_2', d.periods.grade2);
            }
            if(d.t1_front) setValRange('t1_f', d.t1_front);
            if(d.t1_back) setValRange('t1_b', d.t1_back);
            if(d.t2_front) setValRange('t2_f', d.t2_front);
            if(d.t2_back) setValRange('t2_b', d.t2_back);
            if(d.winter) setValRange('winter', d.winter);

            // リストデータの復元
            if (d.festivals && Array.isArray(d.festivals)) {
                tempAcadFestivals = d.festivals.map(f => ({...f, start: f.start.slice(5), end: f.end.slice(5)})); // MM-DD表示用
            }
            if (d.exceptions && Array.isArray(d.exceptions)) {
                tempAcadExceptions = d.exceptions.map(e => ({...e, date: e.date.slice(5)}));
            }
            renderAcadTempLists();

            console.log(`Loaded config for ${y}`);
        }
    } catch(e){ console.error(e); }
}

async function saveAcademicConfig() {
    const yearStr = document.getElementById('acadYear').value;
    if(!yearStr) return alert("年度を入力してください");
    const year = parseInt(yearStr);
    
    const festivals = tempAcadFestivals.map(f => ({
        ...f,
        start: resolveDateYear(f.start, year, true),
        end: resolveDateYear(f.end, year, true)
    }));
    
    const exceptions = tempAcadExceptions.map(e => ({
        ...e,
        date: resolveDateYear(e.date, year, true)
    }));

    // ヘルパー: IDから期間オブジェクト生成
    const getPeriod = (startId, endId) => ({
        start: resolveDateYear(v(startId), year, true),
        end: resolveDateYear(v(endId), year, true)
    });

    const data = {
        // 学期
        t1_front: getPeriod('t1_f_start', 't1_f_end'),
        t1_back: getPeriod('t1_b_start', 't1_b_end'),
        t2_front: getPeriod('t2_f_start', 't2_f_end'),
        t2_back: getPeriod('t2_b_start', 't2_b_end'),
        winter: getPeriod('winter_start', 'winter_end'),
        
        // 特殊期間 (前期/後期で分割)
        periods: {
            reg1: getPeriod('p_reg_1', 'p_reg_1_end'),
            reg2: getPeriod('p_reg_2', 'p_reg_2_end'),
            sup1: getPeriod('p_sup_1', 'p_sup_1_end'),
            sup2: getPeriod('p_sup_2', 'p_sup_2_end'),
            exam1: getPeriod('p_exam_1', 'p_exam_1_end'),
            exam2: getPeriod('p_exam_2', 'p_exam_2_end'),
            grade1: getPeriod('d_grade_1', 'd_grade_1_end'),
            grade2: getPeriod('d_grade_2', 'd_grade_2_end'),
        },
        
        festivals: festivals,
        exceptions: exceptions,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    
    await db.collection('calendar_meta').doc(`config_${year}`).set(data);
    alert(`${year}年度の学年暦を保存しました`);
}

async function loadMonthConfig() {
    const ym = document.getElementById('targetMonth').value;
    if(!ym) return;
    
    await populateCampusSelects();

    const cDiv = document.getElementById('campusActivitySettings');
    cDiv.innerHTML = "";
    
    // UI生成 (デフォルト時間 17:00-19:40)
    registeredCampuses.forEach(c => {
        const div = document.createElement('div');
        div.style.marginBottom = "15px";
        div.innerHTML = `<strong>${c.name}</strong>`;
        const daysDiv = document.createElement('div');
        daysDiv.style.display="flex"; daysDiv.style.flexWrap="wrap"; daysDiv.style.gap="10px";
        
        ['日','月','火','水','木','金','土'].forEach((w, i) => {
            daysDiv.innerHTML += `
                <div style="border:1px solid #eee; padding:5px; border-radius:4px; background:#f9f9f9;">
                    <label style="font-weight:bold; cursor:pointer;">
                        <input type="checkbox" class="act-chk" data-cid="${c.id}" value="${i}"> ${w}
                    </label>
                    <div style="font-size:0.8em; margin-top:2px;">
                        <input type="time" class="act-start" data-cid="${c.id}" data-day="${i}" value="17:00">~
                        <input type="time" class="act-end" data-cid="${c.id}" data-day="${i}" value="19:40">
                    </div>
                </div>`;
        });
        div.appendChild(daysDiv);
        cDiv.appendChild(div);
    });

    // リスト初期化
    tempEvents = [];
    tempNoActivityDays = [];
    
    try {
        const doc = await db.collection('calendars').doc(ym).get();
        if(doc.exists) {
            const d = doc.data();
            
            // チェックボックス & 時間の復元
            if(d.activityDays) {
                for(const [cid, days] of Object.entries(d.activityDays)) {
                    days.forEach(item => {
                        // item は { day: 1, start: "17:00", end: "19:40" } または 古い形式(数値のみ)
                        const idx = (typeof item === 'object') ? item.day : item;
                        
                        const chk = cDiv.querySelector(`.act-chk[data-cid="${cid}"][value="${idx}"]`);
                        if(chk) {
                            chk.checked = true;
                            // 時間があればセット
                            if(typeof item === 'object') {
                                const sInput = cDiv.querySelector(`.act-start[data-cid="${cid}"][data-day="${idx}"]`);
                                const eInput = cDiv.querySelector(`.act-end[data-cid="${cid}"][data-day="${idx}"]`);
                                if(sInput && item.start) sInput.value = item.start;
                                if(eInput && item.end) eInput.value = item.end;
                            }
                        }
                    });
                }
            }
            
            // リスト復元
            tempEvents = d.events || [];
            if(d.noActivityDays && Array.isArray(d.noActivityDays)) {
                // MM-DD表示用に変換 (YYYY-MM-DD -> MM-DD)
                tempNoActivityDays = d.noActivityDays.map(n => ({...n, date: n.date.slice(5)}));
            }
        }
        renderTempEvents();
        renderNoActList();
    } catch(e){ console.error(e); }
}

async function saveMonthCalendar() {
    const ym = document.getElementById('targetMonth').value;
    if(!ym) return alert("年月必須");
    
    // 対象年を取得 (活動なし日の日付変換用)
    const targetYear = parseInt(ym.split('-')[0]);

    const activityDays = {};
    document.querySelectorAll('.act-chk:checked').forEach(chk => {
        const cid = chk.dataset.cid;
        const day = parseInt(chk.value);
        const start = document.querySelector(`.act-start[data-cid="${cid}"][data-day="${day}"]`).value;
        const end = document.querySelector(`.act-end[data-cid="${cid}"][data-day="${day}"]`).value;
        
        if(!activityDays[cid]) activityDays[cid] = [];
        activityDays[cid].push({ day, start, end });
    });

    // 活動なし日の日付変換
    const noActivityDays = tempNoActivityDays.map(item => ({
        ...item,
        date: resolveDateYear(item.date, targetYear, false)
    }));

    await db.collection('calendars').doc(ym).set({
        activityDays,
        events: tempEvents,
        noActivityDays: noActivityDays,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    alert("保存しました");
}

// --- ステータス管理タブ ---
async function refreshCampusStatusList() {
    const list = document.getElementById('status-list');
    if (!list) return;
    list.innerHTML = '読み込み中...';

    try {
        const snap = await db.collection('campuses').orderBy('order').get();
        let html = '<div style="margin-bottom:15px;">※各キャンパスの状況を入力し、下の「全情報を更新」を押してください。</div>';
        
        html += '<div class="status-edit-grid" style="display:flex; flex-direction:column; gap:10px;">';
        
        snap.forEach(doc => {
            const d = doc.data();
            const cid = doc.id;
            // 既存の値がない場合のデフォルト
            const status = d.status || 'open';
            const count = d.currentCount || 0;
            const msg = d.message || '';

            html += `
                <div class="card" style="padding:10px; border:1px solid #ddd; border-radius:8px;">
                    <div style="font-weight:bold; margin-bottom:5px;">${d.name}</div>
                    <div style="display:flex; gap:10px; margin-bottom:5px;">
                        <select id="status-${cid}" class="form-control" style="flex:1;">
                            <option value="open" ${status==='open'?'selected':''}>開室 (Open)</option>
                            <option value="crowded" ${status==='crowded'?'selected':''}>混雑 (Crowded)</option>
                            <option value="closed" ${status==='closed'?'selected':''}>閉室 (Closed)</option>
                            <option value="full" ${status==='full'?'selected':''}>満員 (Full)</option>
                        </select>
                        <input type="number" id="cap-${cid}" class="form-control" placeholder="現在数" value="${count}" style="width:80px;">
                    </div>
                    <input type="text" id="msg-${cid}" class="form-control" placeholder="ひとことメッセージ" value="${msg}" style="width:100%;">
                </div>
            `;
        });
        html += '</div>';

        // 更新ボタン
        html += `
            <div style="margin-top:20px; text-align:center;">
                <button class="btn-primary" onclick="updateAllCampusStatuses()" style="padding:12px 30px; font-size:1.1em; width:100%; max-width:300px;">全情報を更新</button>
            </div>
        `;

        list.innerHTML = html;
    } catch(e) {
        console.error(e);
        list.innerHTML = '読み込みエラー';
    }
}

async function updateAllCampusStatuses() {
    if(!confirm("すべてのキャンパス情報を更新しますか？")) return;
    
    try {
        const snap = await db.collection('campuses').get();
        const batch = db.batch();
        const now = firebase.firestore.FieldValue.serverTimestamp();

        snap.forEach(doc => {
            const cid = doc.id;
            const statusVal = document.getElementById(`status-${cid}`).value;
            const capVal = document.getElementById(`cap-${cid}`).value;
            const msgVal = document.getElementById(`msg-${cid}`).value;

            const ref = db.collection('campuses').doc(cid);
            batch.update(ref, {
                status: statusVal,
                currentCount: parseInt(capVal) || 0,
                message: msgVal,
                updatedAt: now // 更新時刻を記録
            });
        });

        await batch.commit();
        alert("ステータスを更新しました");
        refreshCampusStatusList(); // 再読み込み
    } catch(e) {
        console.error(e);
        alert("更新に失敗しました: " + e.message);
    }
}

async function updateActivityTimeException() {
    const cid = document.getElementById('exTimeCampus').value;
    const date = document.getElementById('exTimeDate').value; // YYYY-MM-DD
    // HTMLに追加されたチェックボックスを取得
    const isCancel = document.getElementById('exTimeCancel') && document.getElementById('exTimeCancel').checked;
    
    if(!cid || !date) return alert("キャンパスと日付は必須です");

    if (isCancel) {
        // 「活動なし」にする -> カレンダーデータの noActivityDays に追加
        const ym = date.substring(0, 7); // YYYY-MM
        try {
            const calRef = db.collection('calendars').doc(ym);
            const doc = await calRef.get();
            let noAct = [];
            if(doc.exists && doc.data().noActivityDays) {
                noAct = doc.data().noActivityDays;
            }
            
            // 重複チェック
            if (!noAct.some(n => n.date === date && n.cid === cid)) {
                const cName = registeredCampuses.find(c => c.id === cid)?.name || cid;
                noAct.push({ cid, date, cName }); 
                await calRef.set({ noActivityDays: noAct }, { merge: true });
                alert(`${date} を活動なし日に設定しました`);
            } else {
                alert("すでに設定済みです");
            }
        } catch(e) { console.error(e); alert("エラーが発生しました"); }
        
    } else {
        // 時間変更 -> activity_exceptions に書き込み
        const start = document.getElementById('exTimeStart').value;
        const end = document.getElementById('exTimeEnd').value;
        if(!start || !end) return alert("時間を入力してください");

        const id = `${date}_${cid}`;
        await db.collection('activity_exceptions').doc(id).set({
            cid, date, start, end,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert("活動時間を変更しました");
    }
}

function switchCalendarSubTab(tab) {
    document.getElementById('view-acad').style.display = tab === 'acad' ? 'block' : 'none';
    document.getElementById('view-monthly').style.display = tab === 'monthly' ? 'block' : 'none';
    
    document.getElementById('btn-sub-acad').classList.remove('active');
    document.getElementById('btn-sub-monthly').classList.remove('active');
    
    if(tab === 'acad') {
        document.getElementById('btn-sub-acad').classList.add('active');
        populateCampusSelects(); 
    }
    if(tab === 'monthly') document.getElementById('btn-sub-monthly').classList.add('active');
}

async function populateCampusSelects() {
    // 1. ユーザー登録用のセレクトボックス
    const regSelect = document.getElementById('regCampusSelect');
    // 2. 活動時間変更用のセレクトボックス (★ここが読み込めていなかった)
    const exSelect = document.getElementById('exTimeCampus');
    
    // 両方なければ何もしない
    if (!regSelect && !exSelect) return;

    try {
        const snap = await db.collection('campuses').get();
        let options = '<option value="">選択してください</option>';
        snap.forEach(doc => {
            const d = doc.data();
            options += `<option value="${doc.id}">${d.name}</option>`;
        });

        if (regSelect) regSelect.innerHTML = options;
        if (exSelect) exSelect.innerHTML = options;

    } catch (e) { console.error(e); }
}

function updateAllAcadDates() {
    document.querySelectorAll('.acad-date').forEach(el => enforceAcadYear(el));
}

function enforceAcadYear(el) {
    // 表示上の補正は行わず、保存時に計算する方針
}

function addAcadFestival() {
    const cid = document.getElementById('fesCampus').value;
    const start = document.getElementById('fesStart').value;
    const end = document.getElementById('fesEnd').value;
    if(!cid || !start) return alert("キャンパスと開始日は必須です");
    
    const cName = registeredCampuses.find(c => c.id === cid)?.name || cid;
    tempAcadFestivals.push({ cid, cName, start, end: end || start });
    renderAcadTempLists();
    document.getElementById('fesStart').value = "";
    document.getElementById('fesEnd').value = "";
}

function addAcadException() {
    const type = document.getElementById('exType').value;
    const date = document.getElementById('exDate').value;
    if(!date) return alert("日付を入力してください");
    
    tempAcadExceptions.push({ type, date });
    renderAcadTempLists();
    document.getElementById('exDate').value = "";
}

function renderAcadTempLists() {
    const fList = document.getElementById('tempFesList');
    fList.innerHTML = "";
    tempAcadFestivals.forEach((f, i) => {
        fList.innerHTML += `<div style="border-bottom:1px solid #eee; padding:5px; display:flex; justify-content:space-between; align-items:center; font-size:0.9em;">
            <span>文化祭(${f.cName}): ${f.start}~${f.end}</span>
            <button onclick="removeAcadFestival(${i})" style="color:white; background:#dc3545; border:none; border-radius:4px; padding:2px 8px; cursor:pointer;">×</button>
        </div>`;
    });

    const eList = document.getElementById('tempExList');
    eList.innerHTML = "";
    tempAcadExceptions.forEach((e, i) => {
        const label = e.type === 'school_day' ? '授業実施' : '休日';
        eList.innerHTML += `<div style="border-bottom:1px solid #eee; padding:5px; display:flex; justify-content:space-between; align-items:center; font-size:0.9em;">
            <span>${label}: ${e.date}</span>
            <button onclick="removeAcadException(${i})" style="color:white; background:#dc3545; border:none; border-radius:4px; padding:2px 8px; cursor:pointer;">×</button>
        </div>`;
    });
}
function renderAcadTempLists() {
    const fList = document.getElementById('tempFesList');
    if(fList) {
        fList.innerHTML = "";
        tempAcadFestivals.forEach((f, i) => {
            fList.innerHTML += `
                <div style="border-bottom:1px solid #eee; padding:5px; display:flex; justify-content:space-between; align-items:center; font-size:0.9em;">
                    <span>文化祭(${f.cName}): ${f.start}~${f.end}</span>
                    <button onclick="removeAcadFestival(${i})" style="color:white; background:#dc3545; border:none; border-radius:4px; padding:2px 8px; cursor:pointer;">×</button>
                </div>`;
        });
    }

    const eList = document.getElementById('tempExList');
    if(eList) {
        eList.innerHTML = "";
        tempAcadExceptions.forEach((e, i) => {
            const label = e.type === 'school_day' ? '授業実施' : '休日';
            eList.innerHTML += `
                <div style="border-bottom:1px solid #eee; padding:5px; display:flex; justify-content:space-between; align-items:center; font-size:0.9em;">
                    <span>${label}: ${e.date}</span>
                    <button onclick="removeAcadException(${i})" style="color:white; background:#dc3545; border:none; border-radius:4px; padding:2px 8px; cursor:pointer;">×</button>
                </div>`;
        });
    }
}

function removeAcadFestival(index) {
    tempAcadFestivals.splice(index, 1);
    renderAcadTempLists();
}

function removeAcadException(index) {
    tempAcadExceptions.splice(index, 1);
    renderAcadTempLists();
}

function toggleEventTitleInput() {
    const type = document.getElementById('evtType').value;
    document.getElementById('evtTitleContainer').style.display = (type === 'event') ? 'block' : 'none';
}

function addNoActivityDay() {
    const cid = document.getElementById('noActCampus').value;
    const date = document.getElementById('noActDate').value;
    if(!cid || !date) return alert("キャンパスと日付は必須です");
    
    const cName = registeredCampuses.find(c => c.id === cid)?.name || cid;
    tempNoActivityDays.push({ cid, cName, date });
    renderNoActList();
    document.getElementById('noActDate').value = "";
}

function renderNoActList() {
    const list = document.getElementById('tempNoActList');
    if(list) {
        list.innerHTML = "";
        tempNoActivityDays.forEach((item, i) => {
            list.innerHTML += `
                <div style="border-bottom:1px solid #eee; padding:5px; font-size:0.9em; display:flex; justify-content:space-between; align-items:center;">
                    <span>${item.cName}: ${item.date} (活動なし)</span>
                    <button onclick="removeNoActivityDay(${i})" style="color:white; background:#dc3545; border:none; border-radius:4px; padding:2px 8px; cursor:pointer;">×</button>
                </div>`;
        });
    }
}

function removeNoActivityDay(index) {
    tempNoActivityDays.splice(index, 1);
    renderNoActList();
}

function addCalendarEvent() {
    const ym = document.getElementById('targetMonth').value;
    if(!ym) return alert("対象年月を選択してください");
    const targetYear = parseInt(ym.split('-')[0]);

    const typeSelect = document.getElementById('evtType');
    const type = typeSelect.value;
    const typeLabel = typeSelect.options[typeSelect.selectedIndex].text;
    
    let title = (type === 'event') ? document.getElementById('evtTitle').value : typeLabel;
    if (!title) return alert("タイトルを入力してください");

    const rawStart = document.getElementById('evtStart').value;
    const rawEnd = document.getElementById('evtEnd').value;
    if(!rawStart) return alert("開始日を入力してください");
    
    const start = resolveDateYear(rawStart, targetYear, false);
    const end = rawEnd ? resolveDateYear(rawEnd, targetYear, false) : start;

    tempEvents.push({ type, start, end, title });
    renderTempEvents();
    
    document.getElementById('evtTitle').value = "";
    document.getElementById('evtStart').value = "";
    document.getElementById('evtEnd').value = "";
}

function renderTempEvents() {
    const list = document.getElementById('tempEventList');
    list.innerHTML = "";
    tempEvents.forEach((evt, i) => {
        list.innerHTML += `<div style="font-size:0.9em; border-bottom:1px solid #eee; padding:5px; display:flex; justify-content:space-between; align-items:center;">
            <span><span class="evt-badge" style="background-color:#666;">${evt.type}</span> ${evt.start}${evt.end!==evt.start ? '~'+evt.end : ''} : <b>${evt.title}</b></span>
            <button onclick="removeCalendarEvent(${i})" style="color:white; background:#dc3545; border:none; border-radius:4px; padding:2px 8px; cursor:pointer;">×</button> 
        </div>`;
    });
}

function removeCalendarEvent(index) {
    tempEvents.splice(index, 1);
    renderTempEvents();
}

function setValRange(idBase, valObj) {
    // valObj は { start: "YYYY-MM-DD", end: "YYYY-MM-DD" } または文字列
    let s = "", e = "";
    if (typeof valObj === 'string') {
        [s, e] = valObj.split(':');
    } else if (valObj) {
        s = valObj.start;
        e = valObj.end;
    }
    
    // start入力欄
    const sEl = document.getElementById(idBase + "_start") || document.getElementById(idBase);
    if(sEl && s) sEl.value = s.slice(5); // YYYY-MM-DD -> MM-DD
    
    // end入力欄
    const eEl = document.getElementById(idBase + "_end");
    if(eEl && e) eEl.value = e.slice(5);
}

function v(id) { 
    const el = document.getElementById(id);
    return el ? el.value : "";
}

async function startFaceRegistration() {
    const select = document.getElementById('regUserSelect');
    if (!select.value) return alert("ユーザーを選択してください");
    
    // 選択されたユーザー名を一時保存
    const userName = select.options[select.selectedIndex].text;
    
    regStep = 1; regDescriptors = []; regThumbnail = ""; currentDetection = null; faceStableCount = 0;
    
    const video = document.getElementById('regVideo');
    const canvas = document.getElementById('regCanvas');
    try {
        await loadModels();
        const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
        regStream = stream; video.srcObject = stream;
        video.onloadedmetadata = () => { 
            video.play(); 
            document.getElementById('regStatus').textContent = `Step 1/5: ${userName}`; 
            detectFaceLoopManual(video, canvas); 
        };
    } catch(e) { alert("カメラエラー: " + e.message); }
}

async function populateRegUserSelect() {
    const select = document.getElementById('regUserSelect');
    if (!select) return;
    select.innerHTML = '<option value="">読み込み中...</option>';
    
    try {
        const snap = await db.collection('users').orderBy('displayName').get();
        select.innerHTML = '<option value="">ユーザーを選択してください</option>';
        snap.forEach(doc => {
            const u = doc.data();
            const option = document.createElement('option');
            option.value = doc.id; // uid
            // わかりやすく表示名と本名を併記
            option.text = `${u.displayName} (${u.realName || '-'})`;
            select.appendChild(option);
        });
    } catch(e) {
        console.error(e);
        select.innerHTML = '<option value="">読み込みエラー</option>';
    }
}

async function saveFaceDataManual() {
    const select = document.getElementById('regUserSelect');
    const uid = select.value;
    const userName = select.options[select.selectedIndex].text;

    if(!uid) return alert("ユーザーIDが不明です");

    document.getElementById('regStatus').textContent = "保存中...";

    try {
        // 1. facesコレクションへの保存 (userIdを追加)
        await db.collection("faces").add({ 
            label: userName, 
            userId: uid,
            thumbnail: regThumbnail, 
            descriptors: regDescriptors 
        });

        // 2. usersコレクションの更新 (顔登録フラグとサムネイル)
        await db.collection("users").doc(uid).update({
            faceRegistered: true,
            faceThumbnail: regThumbnail // Base64画像を保存
        });

        alert(`登録完了: ${userName}`);
        
        // リセット
        if (regStream) { regStream.getTracks().forEach(t => t.stop()); regStream = null; }
        const ctx = document.getElementById('regCanvas').getContext('2d');
        ctx.clearRect(0, 0, 1000, 1000);
        document.getElementById('regStatus').textContent = "完了";
        document.getElementById('regStartBtn').disabled = false;
        document.getElementById('regNextBtn').disabled = true;
        select.value = "";

        // 一覧更新
        refreshAllUsers();

    } catch(e) {
        alert("保存エラー: " + e.message);
        console.error(e);
    }
}

async function refreshAllUsers() {
    const list = document.getElementById('user-list');
    if (!list) return;
    list.innerHTML = '読み込み中...';

    try {
        const snap = await db.collection('users').get();
        let html = '<table class="admin-table"><thead><tr><th>User</th><th>本名</th><th>Discord</th><th>GitHub (ID / Repo)</th><th>Qiita ID</th><th>操作</th></tr></thead><tbody>';
        
        snap.forEach(doc => {
            const d = doc.data();
            const uid = doc.id;
            
            // 各フィールドの値を安全に取得
            const realName = d.realName || "";
            const discord = d.discordName || "";
            const gitId = d.gitId || "";
            const gitRepo = d.gitRepo || "";
            const qiitaId = d.qiitaId || "";

            html += `<tr id="row-${uid}">
                <td>
                    <div style="display:flex; align-items:center; gap:5px;">
                        <img src="${d.photoURL}" style="width:30px; height:30px; border-radius:50%;">
                        <span style="font-size:0.8em;">${d.displayName}</span>
                    </div>
                    <div style="font-size:0.7em; color:#888;">${uid}</div>
                </td>
                <td><input type="text" class="edit-input" name="realName" value="${realName}" disabled style="width:100px;"></td>
                <td><input type="text" class="edit-input" name="discordName" value="${discord}" disabled style="width:100px;"></td>
                <td>
                    ID: <input type="text" class="edit-input" name="gitId" value="${gitId}" disabled style="width:80px; margin-bottom:2px;"><br>
                    Repo: <input type="text" class="edit-input" name="gitRepo" value="${gitRepo}" disabled style="width:80px;">
                </td>
                <td><input type="text" class="edit-input" name="qiitaId" value="${qiitaId}" disabled style="width:80px;"></td>
                <td>
                    <button class="btn-primary" onclick="toggleUserEdit(this, '${uid}')">変更</button>
                    <button class="btn-danger" onclick="deleteItem('users', '${uid}')" style="margin-top:5px;">削除</button>
                </td>
            </tr>`;
        });
        html += '</tbody></table>';
        list.innerHTML = html;
    } catch (e) {
        console.error(e);
        list.innerHTML = 'エラー';
    }
}

// ★追加: 編集モード切り替え & 更新処理
async function toggleUserEdit(btn, uid) {
    const row = document.getElementById(`row-${uid}`);
    const inputs = row.querySelectorAll('.edit-input');
    
    if (btn.textContent === "変更") {
        // 編集モードへ
        inputs.forEach(input => {
            input.disabled = false;
            input.style.border = "1px solid #007bff";
            input.style.backgroundColor = "#fff";
        });
        btn.textContent = "更新";
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-success'); // 緑色などに変えるとベター（CSS次第）
        btn.style.backgroundColor = "#28a745"; 
        
    } else {
        // 更新処理
        const newData = {};
        inputs.forEach(input => {
            newData[input.name] = input.value.trim();
        });

        if(!confirm("この内容で更新しますか？")) return;

        try {
            await db.collection('users').doc(uid).update(newData);
            alert("ユーザー情報を更新しました");
            
            // 読み取り専用に戻す
            inputs.forEach(input => {
                input.disabled = true;
                input.style.border = "1px solid #ccc";
                input.style.backgroundColor = "#f9f9f9"; // disabled色
            });
            btn.textContent = "変更";
            btn.classList.remove('btn-success');
            btn.classList.add('btn-primary');
            btn.style.backgroundColor = ""; // 元の色へ
            
        } catch(e) {
            console.error(e);
            alert("更新に失敗しました: " + e.message);
        }
    }
}

async function loadRegisteredFaces() {
    try {
        const snapshot = await db.collection("faces").get();
        registeredFaces = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.descriptors && data.descriptors.length > 0) {
                 try {
                     const binary = atob(data.descriptors[0]);
                     const len = binary.length;
                     const bytes = new Uint8Array(len);
                     for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
                     const float32 = new Float32Array(bytes.buffer);
                     if (float32.length === 128) {
                         registeredFaces.push({ docId: doc.id, label: data.label, thumbnail: data.thumbnail || null, descriptor: float32 });
                     }
                 } catch(e) {}
            }
        });
    } catch (e) { console.error(e); }
}

async function detectFaceLoopManual(video, canvas) {
    if (regStep > 5 || !regStream) return;
    const displaySize = { width: video.videoWidth, height: video.videoHeight };
    faceapi.matchDimensions(canvas, displaySize);
    try {
        const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
        const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (detection && detection.detection.score > 0.85) {
            faceapi.draw.drawDetections(canvas, faceapi.resizeResults(detection, displaySize));
            if (faceStableCount > 5) {
                currentDetection = detection;
                document.getElementById('regNextBtn').disabled = false;
                document.getElementById('regNextBtn').style.backgroundColor = "#28a745";
            } else { faceStableCount++; }
        }
    } catch(e) {}
    setTimeout(() => detectFaceLoopManual(video, canvas), 100);
}

function proceedToNextStep() {
    if (!currentDetection) return;
    regDescriptors.push(float32ToBase64(currentDetection.descriptor));
    if (regStep === 1) {
        const v = document.getElementById('regVideo');
        const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0); regThumbnail = c.toDataURL('image/jpeg', 0.7);
    }
    regStep++; faceStableCount = 0; currentDetection = null;
    document.getElementById('regNextBtn').disabled = true;
    document.getElementById('regNextBtn').style.backgroundColor = "#ccc";
    if (regStep <= 5) document.getElementById('regStatus').textContent = `Step ${regStep}/5`;
    else saveFaceDataManual();
}

function float32ToBase64(float32) {
    const buffer = float32.buffer; const bytes = new Uint8Array(buffer);
    let binary = ''; for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function switchTab(tabName, btnElement) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    if (btnElement) btnElement.classList.add('active');
    const content = document.getElementById(`tab-${tabName}`);
    if (content) content.classList.add('active');

    // ★追加: カレンダータブを開いたとき、サブタブの初期表示(学年暦)を確実にアクティブにする
    if (tabName === 'calendar') {
        switchCalendarSubTab('acad');
    }
}

async function refreshAuthList() {
    const list = document.getElementById('requestList');
    if(!list) return;
    list.innerHTML = '読み込み中...';
    
    try {
        // 保留中のリクエストを取得
        const snap = await db.collection('auth_requests')
            .where('status', '==', 'pending')
            .orderBy('requestTimestamp', 'desc')
            .get();

        if (snap.empty) {
            list.innerHTML = '<p>現在、承認待ちのリクエストはありません。</p>';
            return;
        }

        let html = '';
        snap.forEach(doc => {
            const d = doc.data();
            const timeStr = d.requestTimestamp ? d.requestTimestamp.toDate().toLocaleString() : '---';
            const authType = d.authType || 'unknown';
            
            html += `
            <div class="card">
                <div style="font-weight:bold; font-size:1.1em;">${d.userName}</div>
                <div style="font-size:0.9em; color:#666;">${timeStr} - ${authType}</div>
                ${d.isLate ? '<div style="color:red; font-weight:bold;">※遅刻申請</div>' : ''}
                <div style="margin-top:10px;">
                    <button class="btn-primary" onclick="openAuthModal('${doc.id}', '${d.userName}', '${d.authType}')">認証画面へ</button>
                    <button class="btn-danger" onclick="rejectRequest('${doc.id}')">却下</button>
                </div>
            </div>`;
        });
        list.innerHTML = html;
    } catch(e) {
        console.error(e);
        list.innerHTML = '<p>読み込みエラー</p>';
    }
}

async function approveRequest() {
    if(!currentRequestId) return;
    await db.collection('auth_requests').doc(currentRequestId).update({ status: 'approved', approvalTimestamp: firebase.firestore.FieldValue.serverTimestamp() });
    await db.collection('attendance_logs').add({ userName: currentAuthUser.name, timestamp: firebase.firestore.FieldValue.serverTimestamp(), adminId: 'web_admin' });
    alert('承認しました');
    closeAuthModal();
    refreshRequests();
}

async function refreshReportList() {
    const list = document.getElementById('reportList');
    if(!list) return;
    list.innerHTML = '読み込み中...';

    try {
        const snap = await db.collection('absence_reports')
            .orderBy('timestamp', 'desc')
            .limit(20)
            .get();

        if(snap.empty) {
            list.innerHTML = '<p>届出はありません</p>';
            return;
        }

        let html = '';
        snap.forEach(doc => {
            const d = doc.data();
            const dateStr = d.timestamp ? d.timestamp.toDate().toLocaleString() : '';
            const typeLabel = (d.type === 'absence') ? '欠席' : ((d.type === 'late') ? '遅刻' : '早退');
            
            html += `
            <div class="card">
                <div style="display:flex; justify-content:space-between;">
                    <strong>${d.userName}</strong>
                    <span style="font-size:0.8em;">${dateStr}</span>
                </div>
                <div>[${typeLabel}] ${d.reason}</div>
                ${d.attachment ? `<div style="margin-top:5px;"><a href="${d.attachment}" target="_blank">添付画像を確認</a></div>` : ''}
                <div style="margin-top:5px; font-size:0.8em; color:gray;">期間: ${d.startDate ? d.startDate.toDate().toLocaleDateString() : ''} ~ </div>
            </div>`;
        });
        list.innerHTML = html;
    } catch(e) {
        list.innerHTML = '<p>読み込みエラー</p>';
    }
}

async function updateReportStatus(docId, st) {
    if(!confirm('変更しますか？')) return;
    await db.collection('absence_reports').doc(docId).update({ status: st });
    refreshReports();
}

async function refreshRecurringList() {
    const list = document.getElementById('recurringList');
    if(!list) return;
    list.innerHTML = '読み込み中...';

    try {
        const snap = await db.collection('recurring_absence').orderBy('createdAt', 'desc').get();
        if(snap.empty) {
            list.innerHTML = '<p>定期欠席の申請はありません</p>';
            return;
        }
        let html = '';
        snap.forEach(doc => {
            const d = doc.data();
            const statusColor = d.status === 'approved' ? 'green' : (d.status === 'rejected' ? 'red' : 'orange');
            const dayStr = ['日','月','火','水','木','金','土'][d.dayOfWeek] || '?';
            
            html += `
            <div class="card" style="border-left: 5px solid ${statusColor};">
                <div style="font-weight:bold;">${d.userName} (${dayStr}曜日)</div>
                <div>理由: ${d.reason}</div>
                <div>状態: <span style="color:${statusColor}">${d.status}</span></div>
                <div style="margin-top:5px;">
                    <button onclick="updateRecurringStatus('${doc.id}', 'approved')" class="btn-primary" style="padding:5px;">承認</button>
                    <button onclick="updateRecurringStatus('${doc.id}', 'rejected')" class="btn-danger" style="padding:5px;">却下</button>
                    <button onclick="deleteRecurring('${doc.id}')" style="padding:5px;">削除</button>
                </div>
            </div>`;
        });
        list.innerHTML = html;
    } catch(e) {
        list.innerHTML = '<p>読み込みエラー</p>';
    }
}

async function approveRecurring(docId) {
    if(!confirm("この内容で承認しますか？")) return;

    const table = document.getElementById(`sched-${docId}`);
    const weekDays = ['月', '火', '水', '木', '金', '土'];
    let resultParts = [];

    weekDays.forEach(day => {
        // 全休チェック確認
        const dayChk = table.querySelector(`.day-chk[data-day="${day}"]`);
        if (dayChk && dayChk.checked) {
            resultParts.push(`${day}:All`);
        } else {
            // 個別時限チェック確認
            const periods = [];
            const pChks = table.querySelectorAll(`.period-chk[data-day="${day}"]:checked`);
            pChks.forEach(chk => periods.push(chk.dataset.period));
            if (periods.length > 0) {
                resultParts.push(`${day}:${periods.join(',')}`);
            }
        }
    });

    const dataString = resultParts.join('|'); // 保存形式: "月:All|水:1,2|金:5"

    await db.collection('recurring_absence_applications').doc(docId).update({
        status: 'approved',
        data: dataString
    });
    refreshRecurring();
}

function toggleDayColumn(checkbox, docId, day) {
    const table = document.getElementById(`sched-${docId}`);
    const cells = table.querySelectorAll(`.p-${day}`);
    const isChecked = checkbox.checked;
    
    // 曜日列のセル背景色を変更 (親のtdの背景を変える)
    cells.forEach(el => {
        const td = el.parentElement;
        if(isChecked) td.classList.add('cell-gray');
        else {
            // 個別チェックがなければ戻す
            if(!el.checked) td.classList.remove('cell-gray');
        }
    });
    // 全休チェック時は親tdもグレーに
    checkbox.parentElement.classList.toggle('cell-gray', isChecked);
}

function togglePeriodCell(checkbox) {
    checkbox.parentElement.classList.toggle('cell-gray', checkbox.checked);
}

async function loadAdminRecommendedArticles() {
    const listEl = document.getElementById('adminNewsList');
    if (!listEl) return;
    listEl.innerHTML = '<p>読み込み中...</p>';
    try {
        const snap = await db.collection('recommended_news').orderBy('timestamp', 'desc').get();
        listEl.innerHTML = '';
        if (snap.empty) { listEl.innerHTML = '<p>登録済み記事はありません</p>'; return; }
        snap.forEach(doc => {
            const d = doc.data();
            const div = document.createElement('div');
            div.className = 'list-item-row';
            div.innerHTML = `
                <div style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    <a href="${d.url}" target="_blank" style="font-weight:bold; text-decoration:none; color:#333;">${d.title}</a>
                </div>
                <button class="btn-danger" onclick="deleteRecommendedArticle('${doc.id}')" style="margin-left:10px;">削除</button>
            `;
            listEl.appendChild(div);
        });
    } catch (e) { listEl.innerHTML = '<p>読み込みエラー</p>'; }
}

async function registerRecommendedArticle() {
    const input = document.getElementById('qiitaInput');
    const urlOrId = input.value.trim();
    if (!urlOrId) return;
    let itemId = urlOrId;
    const match = urlOrId.match(/items\/([a-z0-9]+)/);
    if (match) itemId = match[1];
    try {
        const targetUrl = `https://qiita.com/api/v2/items/${itemId}`;
        const data = await fetchWithProxy(targetUrl);
        await db.collection('recommended_news').add({
            title: data.title, url: data.url, itemId: itemId, timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert(`追加しました: ${data.title}`);
        input.value = "";
        loadAdminRecommendedArticles();
    } catch(e) { alert("エラー: " + e.message); }
}

async function deleteRecommendedArticle(docId) {
    if (!confirm("この記事を削除しますか？")) return;
    await db.collection('recommended_news').doc(docId).delete();
    loadAdminRecommendedArticles();
}

async function registerCampus() {
    const name = document.getElementById('campusName').value;
    const lat = parseFloat(document.getElementById('campusLat').value);
    const lon = parseFloat(document.getElementById('campusLon').value);
    await db.collection('campuses').add({ name, lat, lon });
    loadCampuses(); populateInfoLists(); alert("登録しました");
}

async function registerArea() {
    const campusId = document.getElementById('campusSelect').value;
    const name = document.getElementById('areaName').value;
    const lat = parseFloat(document.getElementById('areaLat').value);
    const lon = parseFloat(document.getElementById('areaLon').value);
    await db.collection('gps_areas').doc(name).set({ name, campusId, lat, lon, isActive: false });
    loadGpsAreas(); populateInfoLists(); alert("登録しました");
}

function populateInfoLists() {
    const select = document.getElementById('campusSelect');
    if(select) {
        select.innerHTML = '<option value="">キャンパスを選択</option>';
        registeredCampuses.forEach(c => { const opt = document.createElement('option'); opt.value = c.id; opt.innerText = c.name; select.appendChild(opt); });
    }

    const hierList = document.getElementById('hierarchyList');
    if(hierList) {
        hierList.innerHTML = '';
        registeredCampuses.forEach(campus => {
            const areas = registeredGpsAreas.filter(a => a.campusId === campus.id);
            
            const details = document.createElement('details');
            details.className = 'settings-details';
            
            const summary = document.createElement('summary');
            // ★修正: 親要素(summary)がFlexboxなので、中身はシンプルにグループ化するだけにする
            // width:100%を削除し、表示崩れを防ぐ
            summary.innerHTML = `
                <div style="display:flex; align-items:center;">
                    <input type="checkbox" class="chk-campus" value="${campus.id}" style="margin-right: 10px;">
                    <span style="font-weight:bold;">🏢 ${campus.name} (${areas.length})</span>
                </div>
            `;
            
            const content = document.createElement('div');
            content.className = 'details-content';
            
            if (areas.length > 0) {
                const actionDiv = document.createElement('div');
                actionDiv.style.cssText = 'display:flex; justify-content:flex-end; gap:10px; margin-bottom:10px;';
                actionDiv.innerHTML = `<button class="btn-danger" onclick="deleteSelectedAreas('${campus.id}')">選択削除</button><button class="btn-danger" onclick="deleteAllAreasInCampus('${campus.id}')">全削除</button>`;
                content.appendChild(actionDiv);
                
                areas.forEach(area => {
                    const row = document.createElement('div');
                    row.className = 'list-item-row nested-area';
                    if(area.isActive) row.style.backgroundColor = '#e6ffec';
                    
                    // ★修正: 左側の要素(チェックボックス+名前)をFlexで束ねる
                    // 座標を表示しつつ、フォントサイズを小さくしてガタつきを目立たなくする
                    row.innerHTML = `
                        <div style="display:flex; align-items:center;">
                            <input type="checkbox" class="chk-area-${campus.id}" value="${area.name}" style="margin-right: 10px;">
                            <div style="text-align:left; line-height:1.2;">
                                <strong>📍 ${area.name}</strong>
                                <span style="font-size:0.8em; color:#888; margin-left:5px;">(${area.lat.toFixed(4)}, ${area.lon.toFixed(4)})</span>
                            </div>
                        </div>
                        <div style="white-space:nowrap;">
                            <button onclick="toggleAreaActive('${area.name}', ${area.isActive})" style="margin-right:5px; padding:5px 10px;">切替</button>
                            <button class="btn-danger" onclick="deleteItem('gps_areas', '${area.name}')" style="padding:5px 10px;">削除</button>
                        </div>`;
                    content.appendChild(row);
                });
            } else {
                content.innerHTML = '<p style="color:#888; text-align:left; padding-left:10px; margin:0;">(エリア未登録)</p>';
            }
            
            details.appendChild(summary); details.appendChild(content); hierList.appendChild(details);
        });
    }
    populateFaceList();
}

async function toggleAreaActive(docId, currentStatus) {
    await db.collection('gps_areas').doc(docId).update({ isActive: !currentStatus });
    loadGpsAreas(); populateInfoLists();
}

function populateFaceList() {
    const el = document.getElementById('faceList');
    if(!el) return;
    el.innerHTML = '';
    registeredFaces.forEach(f => {
        const div = document.createElement('div');
        div.className = 'list-item-row';
        div.innerHTML = `<div class="checkbox-wrapper"><input type="checkbox" class="chk-face" value="${f.docId}"><strong>${f.label}</strong></div><button class="btn-danger" onclick="deleteItem('faces', '${f.docId}')">削除</button>`;
        el.appendChild(div);
    });
}

async function deleteItem(collection, id) {
    if(!confirm('削除しますか？')) return;
    await db.collection(collection).doc(id).delete();
    reloadAllData();
}

async function deleteSelectedItems(type) {
    let inputs, collection;
    if (type === 'campuses') { inputs = document.querySelectorAll('.chk-campus:checked'); collection = 'campuses'; }
    else if (type === 'faces') { inputs = document.querySelectorAll('.chk-face:checked'); collection = 'faces'; }
    
    if (inputs.length === 0) return alert("選択されていません");
    
    // ★追加: 警告ダイアログ
    if (!confirm(`${inputs.length}件のデータを削除しますか？\nこの操作は取り消せません。`)) return;

    const batch = db.batch();
    inputs.forEach(input => { batch.delete(db.collection(collection).doc(input.value)); });
    await batch.commit();
    reloadAllData();
}

async function deleteSelectedAreas(campusId) {
    const inputs = document.querySelectorAll(`.chk-area-${campusId}:checked`);
    
    if (inputs.length === 0) return alert("選択されていません");

    // ★追加: 警告ダイアログ
    if (!confirm(`${inputs.length}件の活動場所を削除しますか？`)) return;

    const batch = db.batch();
    inputs.forEach(input => { batch.delete(db.collection('gps_areas').doc(input.value)); });
    await batch.commit();
    reloadAllData();
}

async function deleteAllAreasInCampus(campusId) {
    const snap = await db.collection('gps_areas').where('campusId', '==', campusId).get();
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    reloadAllData();
}

async function deleteAll(collection) {
    if(!confirm(`${collection} を全て削除しますか？この操作は取り消せません。`)) return;
    
    try {
        const snap = await db.collection(collection).get();
        const batch = db.batch();
        snap.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        alert("削除しました");
        reloadAllData(); // 画面更新
    } catch(e) {
        console.error("Delete Error:", e);
        alert("削除に失敗しました");
    }
}

async function reloadAllData() {
    await loadCampuses(); await loadGpsAreas(); await loadRegisteredFaces(); populateInfoLists();
}

async function openAuthModal(reqId, userName, authTypeString) {
    currentRequestId = reqId;
    adminAuthStep = 0;
    colorMatchCounter = 0;
    const parts = authTypeString.split(',');
    const targetCode = parts[0].includes('code') && parts.length >= 5 ? parts.slice(1, 5) : [];
    const registered = registeredFaces.find(f => f.label === userName);
    currentAuthUser = { name: userName, targetCode: targetCode, descriptor: registered ? registered.descriptor : null };

    const modal = document.getElementById('authModal');
    modal.style.display = 'block';
    updateAdminStatus("コードを枠に合わせてください");
    document.getElementById('approveBtn').disabled = true;
    
    const video = document.getElementById('adminVideo');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
        video.onloadedmetadata = () => { video.play(); processAdminFrame(); };
    } catch(e) { alert("カメラ起動エラー: " + e.message); }
}

function closeAuthModal() {
    document.getElementById('authModal').style.display = 'none';
    const video = document.getElementById('adminVideo');
    if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
    if (adminGuideLoopId) { cancelAnimationFrame(adminGuideLoopId); adminGuideLoopId = null; }
}

function updateAdminStatus(msg) {
    document.getElementById('modalTitle').textContent = `${currentAuthUser ? currentAuthUser.name : ''} 認証`;
    document.getElementById('adminAuthStatus').textContent = msg;
}

async function processAdminFrame() {
    const canvas = document.getElementById('adminCanvas');
    const video = document.getElementById('adminVideo');
    const modal = document.getElementById('authModal');
    if (modal.style.display === 'none' || !canvas || !video || video.paused || video.ended) return;

    if (video.videoWidth > 0 && canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
    const ctx = canvas.getContext('2d');
    const w = canvas.width; const h = canvas.height;
    ctx.drawImage(video, 0, 0, w, h);

    if (adminAuthStep === 0) {
        if (currentAuthUser.targetCode.length === 4) {
            const detectedCode = scanColors(ctx, w, h);
            if (isCodeMatch(detectedCode, currentAuthUser.targetCode)) {
                colorMatchCounter++;
                if (colorMatchCounter > 10) { adminAuthStep = 1; updateAdminStatus("コード一致！ 次は「顔」を映してください"); }
            } else { colorMatchCounter = Math.max(0, colorMatchCounter - 1); }
        } else { adminAuthStep = 1; }
    } else if (adminAuthStep === 1) {
        if (currentAuthUser.descriptor) {
            try {
                const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
                if (detection) {
                    const dist = faceapi.euclideanDistance(detection.descriptor, currentAuthUser.descriptor);
                    if (dist < 0.6) {
                        adminAuthStep = 2;
                        updateAdminStatus("本人確認完了！");
                        document.getElementById('approveBtn').disabled = false;
                    }
                }
            } catch(e) {}
        } else {
            updateAdminStatus("顔データなし (スキップ可)");
            document.getElementById('approveBtn').disabled = false;
        }
    }
    drawAdminGuide(ctx, w, h, adminAuthStep);
    adminGuideLoopId = requestAnimationFrame(processAdminFrame);
}

function scanColors(ctx, w, h) {
    const refW = 230; const refH = 170;
    const scale = Math.min(w / refW, h / refH) * 0.8;
    const offsetX = (w - refW * scale) / 2; const offsetY = (h - refH * scale) / 2;
    const t = (x, y) => ({ x: Math.floor(offsetX + x * scale), y: Math.floor(offsetY + y * scale) });
    // H型の4箇所をサンプリング
    const points = [ t(55, 85), t(115, 55), t(115, 105), t(175, 85) ];
    const imageData = ctx.getImageData(0, 0, w, h).data;
    return points.map(p => {
        const i = (p.y * w + p.x) * 4;
        return classifyColor(imageData[i], imageData[i+1], imageData[i+2]);
    });
}

function classifyColor(r, g, b) {
    const max = Math.max(r, g, b); const min = Math.min(r, g, b);
    if ((max - min) < 40) return '?';
    if (g > 150 && b > 150 && r < 120) return 'C'; // Cyan
    if (r > 150 && g > 150 && b < 120) return 'Y'; // Yellow
    if (r > 150 && b > 150 && g < 120) return 'M'; // Magenta
    if (g > 100 && r < 100 && b < 100) return 'G'; // Green
    return '?';
}

function isCodeMatch(detected, target) {
    for (let i = 0; i < 4; i++) if (detected[i] !== target[i]) return false;
    return true;
}

function drawAdminGuide(ctx, w, h, step) {
    const refW = 230; const refH = 170;
    const scale = Math.min(w / refW, h / refH) * 0.8;
    const offsetX = (w - refW * scale) / 2; const offsetY = (h - refH * scale) / 2;
    const t = (x, y) => ({ x: x * scale + offsetX, y: y * scale + offsetY });
    ctx.lineWidth = 4; ctx.lineCap = "round";
    const alpha = step === 0 ? 1.0 : 0.2;
    
    // ガイド枠描画 (H型の周辺)
    ctx.strokeStyle = `rgba(255, 0, 0, ${alpha})`;
    ctx.beginPath(); let p = t(30, 50); ctx.moveTo(p.x, p.y); p = t(30, 30); ctx.lineTo(p.x, p.y); p = t(50, 30); ctx.lineTo(p.x, p.y); ctx.stroke();
    
    if (step === 0) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
        const fillRect = (x1,y1,x2,y2) => { const s = t(x1,y1); const e = t(x2,y2); ctx.fillRect(s.x, s.y, e.x - s.x, e.y - s.y); };
        // H型の透過マスク
        fillRect(40, 40, 70, 130); fillRect(70, 70, 150, 100); fillRect(150, 40, 180, 130);
    }
}

function updateMonthlyBaseYear() {}
function enforceMonthlyYear(el) {}

// --- pre_admin.js への追加コード ---

// 1. 備品管理エリアの描画 (initAdminPageなどで「キャンパス管理」の前などに呼ぶ)
// --- 備品管理 (initAdminPageで呼び出し) ---
async function renderEquipmentManagement() {
    const container = document.getElementById('equipment-manage-container');
    if (!container) return; // 要素がなければ安全に終了

    // HTML描画
    container.innerHTML = `
        <div class="input-group">
            <input type="text" id="newEqName" placeholder="備品名" class="form-control">
            <input type="number" id="newEqDuration" placeholder="最大貸出日数 (空欄で無制限)" style="width:180px;" class="form-control">
            <select id="newEqCampus" class="form-control"><option value="">受取キャンパスを読み込み中...</option></select>
            <button onclick="addEquipment()" class="btn-primary">登録</button>
        </div>
        <div id="equipment-list-admin" class="list-container" style="margin-top:15px; min-height:50px;">
            <p>読み込み中...</p>
        </div>
        <button onclick="refreshAdminEquipmentList()" class="refresh-btn" style="margin-top:10px;">リスト更新</button>
    `;

    // ★修正: キャンパス選択肢の読み込み (registeredCampuses利用 + フォールバック)
    const cSelect = document.getElementById('newEqCampus');
    if (cSelect) {
        let campuses = [];
        
        // 1. すでにロード済みの共通変数を使う
        if (typeof registeredCampuses !== 'undefined' && registeredCampuses.length > 0) {
            campuses = registeredCampuses;
        } else {
            // 2. なければFirestoreから直接取得
            try {
                const snap = await db.collection('campuses').get();
                snap.forEach(doc => campuses.push({ id: doc.id, ...doc.data() }));
            } catch (e) {
                console.error("Campus load error:", e);
                cSelect.innerHTML = '<option value="">読み込みエラー</option>';
                return;
            }
        }

        if (campuses.length === 0) {
            cSelect.innerHTML = '<option value="">キャンパス登録がありません</option>';
        } else {
            let opts = '<option value="">受取キャンパスを選択</option>';
            campuses.forEach(c => {
                opts += `<option value="${c.id}">${c.name}</option>`;
            });
            cSelect.innerHTML = opts;
        }
    }

    // 備品一覧の更新
    refreshAdminEquipmentList();
}

// --- 備品追加関数 ---
async function addEquipment() {
    const nameInput = document.getElementById('newEqName');
    const durInput = document.getElementById('newEqDuration');
    const cidInput = document.getElementById('newEqCampus');

    if (!nameInput || !cidInput) return; // DOMがない場合

    const name = nameInput.value;
    const dur = durInput.value;
    const cid = cidInput.value;

    if (!name || !cid) return alert("備品名とキャンパスは必須です");
    if (!confirm("登録しますか？")) return;

    try {
        await db.collection('equipments').add({
            name: name,
            maxDuration: dur ? parseInt(dur) : null,
            campusId: cid,
            status: 'available',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert("登録しました");
        nameInput.value = "";
        durInput.value = "";
        // キャンパスは選択したままにする
        refreshAdminEquipmentList();
    } catch (e) {
        alert("エラー: " + e.message);
    }
}

// --- 備品一覧取得関数 (フリーズ防止版) ---
async function refreshAdminEquipmentList() {
    const list = document.getElementById('equipment-list-admin');
    if (!list) return;

    list.innerHTML = '<p>読み込み中...</p>';

    try {
        const snap = await db.collection('equipments').orderBy('name').get();
        
        if (snap.empty) {
            list.innerHTML = '<p>登録された備品はありません</p>';
            return;
        }

        let html = '<table class="admin-table"><thead><tr><th>備品名</th><th>制限</th><th>場所</th><th>状態</th><th>操作</th></tr></thead><tbody>';
        
        snap.forEach(doc => {
            const d = doc.data();
            const statusLabel = d.status === 'loaned' ? '<span style="color:red; font-weight:bold;">貸出中</span>' : '<span style="color:green;">可</span>';
            
            // キャンパス名解決 (registeredCampusesがあれば使う)
            let cName = d.campusId;
            if (typeof registeredCampuses !== 'undefined') {
                const c = registeredCampuses.find(x => x.id === d.campusId);
                if (c) cName = c.name;
            }

            html += `
                <tr>
                    <td>${d.name || '-'}</td>
                    <td>${d.maxDuration ? d.maxDuration + '日' : '無制限'}</td>
                    <td style="font-size:0.9em;">${cName}</td>
                    <td>${statusLabel}</td>
                    <td>
                        <button class="btn-danger" onclick="deleteItem('equipments', '${doc.id}')" style="padding:2px 5px; font-size:0.8em;">削除</button>
                        ${d.status === 'loaned' ? `<button class="btn-primary" onclick="forceReturnEquipment('${doc.id}')" style="margin-left:5px; padding:2px 5px; font-size:0.8em;">強制返却</button>` : ''}
                    </td>
                </tr>
            `;
        });
        html += '</tbody></table>';
        list.innerHTML = html;

    } catch (e) {
        console.error(e);
        list.innerHTML = '<p style="color:red;">読み込みエラーが発生しました</p>';
    }
}

// --- 強制返却関数 ---
async function forceReturnEquipment(eqId) {
    if (!confirm("強制的に「貸出可」に戻しますか？\n(現在貸出中のユーザー情報は削除されます)")) return;
    try {
        await db.collection('equipments').doc(eqId).update({
            status: 'available',
            currentLoan: firebase.firestore.FieldValue.delete()
        });
        refreshAdminEquipmentList();
    } catch (e) { alert("エラー: " + e.message); }
}

// --- サブタブ切り替え関数 (フリーズ防止 & 備品タブ対応) ---
window.switchAdminSubTab = function(subTabName) {
    // 1. 全サブタブボタンの active クラスを解除
    const btns = document.querySelectorAll('#tab-status .sub-tab');
    btns.forEach(b => b.classList.remove('active'));
    
    // 2. クリックされたボタンに active クラスを付与
    const targetBtn = document.getElementById('btn-sub-' + subTabName);
    if(targetBtn) targetBtn.classList.add('active');

    // 3. すべてのビューを非表示にする
    // (auth: 認証, report: 届出, recurring: 定期欠席, equipment: 備品承認)
    const views = ['auth', 'report', 'recurring', 'equipment'];
    views.forEach(v => {
        const el = document.getElementById('view-' + v);
        if(el) el.style.display = 'none';
    });

    // 4. 対象のビューを表示し、データを更新する
    const targetView = document.getElementById('view-' + subTabName);
    if(targetView) {
        targetView.style.display = 'block';

        // ★各リストの更新関数を呼び出して情報を最新にする
        if (subTabName === 'auth') {
            if(typeof refreshAuthList === 'function') refreshAuthList();
        } else if (subTabName === 'report') {
            if(typeof refreshReportList === 'function') refreshReportList();
        } else if (subTabName === 'recurring') {
            if(typeof refreshRecurringList === 'function') refreshRecurringList();
        } else if (subTabName === 'equipment') {
            if(typeof refreshEquipmentRequests === 'function') refreshEquipmentRequests();
        }
    }
};

// --- 備品承認リスト取得関数 (フリーズ防止版) ---
async function refreshEquipmentRequests() {
    const container = document.getElementById('approval-list');
    if (!container) return;

    container.innerHTML = '<p>読み込み中...</p>';
    
    try {
        const snap = await db.collection('equipment_requests')
            .where('status', '==', 'pending')
            .orderBy('timestamp', 'asc')
            .get();

        if (snap.empty) {
            container.innerHTML = "<p>承認待ちの申請はありません</p>";
            return;
        }

        let html = '<div style="display:flex; flex-direction:column; gap:10px;">';
        snap.forEach(doc => {
            const d = doc.data();
            // 日付の安全な変換
            let rangeText = "期間不明";
            if (d.startDate && d.endDate) {
                try {
                    const start = d.startDate.toDate().toLocaleDateString();
                    const end = d.endDate.toDate().toLocaleDateString();
                    rangeText = `${start} 〜 ${end}`;
                } catch(err) { rangeText = "日付形式エラー"; }
            }

            html += `
                <div class="card" style="padding:10px; border:1px solid #ddd;">
                    <div><strong>${d.userName || '不明なユーザー'}</strong> が <strong>${d.equipmentName || '不明な備品'}</strong> を希望</div>
                    <div style="font-size:0.9em; color:#555;">期間: ${rangeText}</div>
                    <div style="margin-top:10px;">
                        <button class="btn-primary" onclick="handleEqRequest('${doc.id}', true)">承認</button>
                        <button class="btn-danger" onclick="handleEqRequest('${doc.id}', false)">却下</button>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        container.innerHTML = html;
    } catch(e) {
        console.error(e);
        container.innerHTML = '<p style="color:red;">読み込みエラーが発生しました</p>';
    }
}

// --- 承認/却下アクション関数 ---
async function handleEqRequest(reqId, isApproved) {
    if (!confirm(isApproved ? "承認しますか？" : "却下しますか？")) return;

    try {
        const reqRef = db.collection('equipment_requests').doc(reqId);
        const reqDoc = await reqRef.get();
        if (!reqDoc.exists) { alert("申請が見つかりません(削除された可能性があります)"); return; }
        
        const data = reqDoc.data();

        if (isApproved) {
            // 備品マスタの状態を「貸出中」に更新
            await db.collection('equipments').doc(data.equipmentId).update({
                status: 'loaned',
                currentLoan: {
                    userId: data.userId,
                    userName: data.userName,
                    startDate: data.startDate,
                    endDate: data.endDate
                }
            });
            await reqRef.update({ status: 'approved' });
        } else {
            await reqRef.update({ status: 'rejected' });
        }

        alert("処理しました");
        refreshEquipmentRequests();
        
        // もし備品一覧が表示されていれば更新する
        if (document.getElementById('equipment-list-admin')) refreshAdminEquipmentList();

    } catch (e) {
        alert("エラーが発生しました: " + e.message);
        console.error(e);
    }
}
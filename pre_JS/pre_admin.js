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
    
    // 備品管理エリアの描画
    renderEquipmentManagement();

    // デフォルトで「ステータス」タブを開く
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

    // 初期表示時に「認証リクエスト」サブタブを強制的に読み込む
    switchAdminSubTab('auth');

    // ★追加: 「活動時間変更」エリアのチェックボックスレイアウト修正 (JSから強制適用)
    const exTimeLabel = document.querySelector('label[for="exTimeCancel"]');
    if(!exTimeLabel) {
        // 親要素経由で探す (HTML構造に依存)
        const chk = document.getElementById('exTimeCancel');
        if(chk && chk.parentElement) {
            chk.parentElement.style.cssText = "display:flex; align-items:center; gap:10px; padding:10px; background:#fff3cd; border-radius:5px; cursor:pointer;";
            chk.style.cssText = "width:20px; height:20px; margin:0;";
        }
    }
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
    
    // ★修正: 前回追加したラジオボタン挿入ロジックを削除
    const existingContainer = document.getElementById('regTargetContainer');
    if (existingContainer) existingContainer.remove();
    
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

    // ★修正: 常に web_faces に保存
    const collectionName = 'web_faces';
    const flagField = 'webFaceRegistered';
    const thumbField = 'webFaceThumbnail';

    document.getElementById('regStatus').textContent = "保存中...";

    try {
        // 1. web_faces への保存
        await db.collection(collectionName).add({ 
            label: userName, 
            userId: uid,
            thumbnail: regThumbnail, 
            descriptors: regDescriptors 
        });

        // 2. usersコレクションの更新 (Web用のフラグ)
        await db.collection("users").doc(uid).update({
            [flagField]: true,
            [thumbField]: regThumbnail 
        });

        alert(`登録完了 (Web): ${userName}`);
        
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
        // 顔一覧も更新
        await loadRegisteredFaces();
        populateFaceList();

    } catch(e) {
        alert("保存エラー: " + e.message);
        console.error(e);
    }
}

async function refreshAllUsers() {
    const list = document.getElementById('allUsersList');
    if (!list) return;
    list.innerHTML = '読み込み中...';

    try {
        const snap = await db.collection('users').get();
        if (snap.empty) {
            list.innerHTML = '<p>ユーザーがいません</p>';
            return;
        }

        let html = '<div style="display:flex; flex-direction:column; gap:10px;">';
        
        snap.forEach(doc => {
            const d = doc.data();
            const uid = doc.id;
            
            // --- データ整形ヘルパー ---
            const safeStr = (v) => (v === undefined || v === null || v === '') ? '無し' : String(v);
            // 配列用ヘルパー: 空なら「無し」
            const joinList = (arr) => (Array.isArray(arr) && arr.length > 0) ? arr.join('•') : '無し';
            
            // 削除済みタグ用
            const joinHiddenTags = (arr) => {
                if (!Array.isArray(arr) || arr.length === 0) return '無し';
                return arr.map(item => (typeof item === 'object' && item.tag) ? item.tag : item).join('•');
            };

            // 1. 名前系
            const realName = d.realName || d.displayName || '名称未設定';
            const dispName = d.displayName || '未設定';

            // 2. 顔登録 (Web / Flutter 分岐)
            // Web用
            let webFaceHtml = '<span style="color:red; font-weight:bold;">未</span>';
            if (d.webFaceRegistered) {
                // 画像がある場合のみ画像を表示(文字は出さない)
                if (d.webFaceThumbnail) {
                    webFaceHtml = `<img src="${d.webFaceThumbnail}" style="max-height:60px; border:1px solid #ccc; display:block;">`;
                } else {
                    webFaceHtml = '<span style="color:green; font-weight:bold;">済(画像なし)</span>';
                }
            }
            
            // Flutter(既存)用
            let flutterFaceHtml = '<span style="color:red; font-weight:bold;">未</span>';
            if (d.faceRegistered) {
                if (d.faceThumbnail) {
                    flutterFaceHtml = `<img src="${d.faceThumbnail}" style="max-height:60px; border:1px solid #ccc; display:block;">`;
                } else {
                    flutterFaceHtml = '<span style="color:green; font-weight:bold;">済(画像なし)</span>';
                }
            }

            // 3. アプリ内アイコン
            let appIconHtml = '無し';
            if (d.customIcon) {
                appIconHtml = `<img src="${d.customIcon}" style="width:40px; height:40px; border-radius:50%; border:1px solid #ddd;">`;
            } else if (d.photoURL) {
                appIconHtml = `<img src="${d.photoURL}" style="width:40px; height:40px; border-radius:50%; border:1px solid #ddd;">`;
            }

            // 4. ステータス・属性
            const isMemStr = d.isMember ? '部員' : '非部員';
            const gradeStr = d.grade ? d.grade : '未設定';
            const roleStr = d.role || '無し';
            const isAdminStr = d.isAdmin ? '管理者' : '一般';
            
            // 貸出物
            let borrowedStr = '無し';
            if (Array.isArray(d.borrowedItems) && d.borrowedItems.length > 0) {
                borrowedStr = d.borrowedItems.map(i => i.name).join('•');
            }

            // 5. Discord
            const discordIconSrc = d.discordIcon || d.photoURL || 'https://via.placeholder.com/40';
            const discordName = d.discordName || '無し';
            const discordId = d.discordId || '無し';

            // その他
            const qiitaId = d.qiitaId || '無し';
            const gitId = d.gitId || '無し';
            const gitRepo = d.gitRepo || '無し';
            const profileText = d.profileText || '無し';
            const adminMemo = d.adminMemo || '無し';
            const groupsStr = joinList(d.groups);

            // タグ
            const manualInt = joinList(d.manualInterests);
            const manualTech = joinList(d.manualTechStack);
            const autoInt = joinList(d.autoInterests);
            const autoTech = joinList(d.autoTechStack);
            
            const hiddenInt = joinHiddenTags(d.hiddenInterests);
            const hiddenTech = joinHiddenTags(d.hiddenTechStack);

            // 評価
            const rAct = d.rateActivity || 0;
            const rTeam = d.rateTeam || 0;
            const rCurr = d.rateCurriculum || 0;
            const rFri = d.rateFriends || 0;

            // --- HTML生成 (details/summary でデフォルト閉じる) ---
            html += `
            <details class="card" id="row-${uid}" style="padding:0; border:1px solid #ddd; overflow:hidden;">
                <summary style="padding:15px; background-color:#f8f9fa; cursor:pointer; font-weight:bold; outline:none;">
                    本名：${realName}
                </summary>
                
                <div style="padding:15px; border-top:1px solid #eee; text-align:left;">
                    
                    <div style="margin-bottom:10px; font-weight:bold; color:#007bff;">
                        アプリ内名：${dispName}
                    </div>

                    <div style="display:flex; flex-wrap:wrap; gap:20px; margin-bottom:10px; align-items:flex-start;">
                        <div>
                            <div style="font-size:0.9em; font-weight:bold; color:#555;">Web顔登録</div>
                            ${webFaceHtml}
                        </div>
                        <div>
                            <div style="font-size:0.9em; font-weight:bold; color:#555;">Flutter顔登録</div>
                            ${flutterFaceHtml}
                        </div>
                        <div>
                            <div style="font-size:0.9em; font-weight:bold; color:#555;">アプリ内アイコン</div>
                            <div>${appIconHtml}</div>
                        </div>
                        <div style="display:flex; align-items:center; gap:10px; border:1px solid #eee; padding:5px; border-radius:5px;">
                            <img src="${discordIconSrc}" style="width:40px; height:40px; border-radius:50%;">
                            <div style="font-size:0.85em; line-height:1.3;">
                                Discord名：${discordName}<br>
                                DiscordID：${discordId}
                            </div>
                        </div>
                    </div>

                    <div style="background:#f1f8ff; padding:8px; border-radius:5px; margin-bottom:10px; font-weight:bold; font-size:0.95em;">
                        ${isMemStr} / ${gradeStr}回生 / ${roleStr} / 貸出：${borrowedStr} / ${isAdminStr}
                    </div>

                    <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; margin-bottom:10px;">
                        <div><span style="font-size:0.8em; color:#666;">QiitaID</span><input type="text" class="edit-input form-control" name="qiitaId" value="${qiitaId === '無し' ? '' : qiitaId}" placeholder="無し" disabled style="padding:4px;"></div>
                        <div><span style="font-size:0.8em; color:#666;">GitID</span><input type="text" class="edit-input form-control" name="gitId" value="${gitId === '無し' ? '' : gitId}" placeholder="無し" disabled style="padding:4px;"></div>
                        <div><span style="font-size:0.8em; color:#666;">GitRepo</span><input type="text" class="edit-input form-control" name="gitRepo" value="${gitRepo === '無し' ? '' : gitRepo}" placeholder="無し" disabled style="padding:4px;"></div>
                    </div>

                    <div style="margin-bottom:10px;">
                        <span style="font-size:0.8em; color:#666; font-weight:bold;">自己紹介文</span>
                        <div style="background:#f9f9f9; padding:8px; border-radius:4px; font-size:0.9em; min-height:1.5em; white-space:pre-wrap;">${profileText}</div>
                    </div>

                    <div style="margin-bottom:5px; font-size:0.9em;">
                        <span style="color:#007bff;">[現在タグ]</span> ${manualInt} / ${manualTech} / ${autoInt} / ${autoTech}
                    </div>
                    <div style="margin-bottom:15px; font-size:0.9em; color:#888;">
                        <span>[削除タグ]</span> ${hiddenInt} / ${hiddenTech}
                    </div>

                    <div style="border-top:2px dashed #ddd; padding-top:10px; background:#fafafa; margin:-5px -15px -15px -15px; padding: 15px;">
                        <div style="margin-bottom:10px;">
                            <span style="font-size:0.8em; font-weight:bold;">管理者所感</span>
                            <textarea class="edit-input form-control" name="adminMemo" rows="2" disabled style="width:100%; margin-top:3px;" placeholder="無し">${adminMemo === '無し' ? '' : adminMemo}</textarea>
                        </div>

                        <div style="margin-bottom:10px;">
                            <span style="font-size:0.8em; font-weight:bold;">所属グループ (カンマ区切り)</span>
                            <input type="text" class="edit-input form-control" name="groups" value="${groupsStr === '無し' ? '' : groupsStr}" disabled style="width:100%; margin-top:3px;" placeholder="無し">
                        </div>

                        <div style="display:flex; flex-wrap:wrap; gap:10px; align-items:center; font-size:0.9em;">
                            <span style="font-weight:bold;">意欲(%)</span>
                            <label>活動 <input type="number" class="edit-input" name="rateActivity" value="${rAct}" disabled style="width:50px;"></label> /
                            <label>チーム <input type="number" class="edit-input" name="rateTeam" value="${rTeam}" disabled style="width:50px;"></label> /
                            <label>カリキュラム <input type="number" class="edit-input" name="rateCurriculum" value="${rCurr}" disabled style="width:50px;"></label> /
                            <label>コミュ <input type="number" class="edit-input" name="rateFriends" value="${rFri}" disabled style="width:50px;"></label>
                        </div>

                        <div style="text-align:right; margin-top:15px;">
                            <button class="btn-primary" onclick="toggleUserEdit(this, '${uid}')">変更</button>
                            <button class="btn-danger" onclick="deleteItem('users', '${uid}')" style="margin-left:10px;">削除</button>
                        </div>
                    </div>
                </div>
            </details>`;
        });
        
        html += '</div>';
        list.innerHTML = html;

    } catch (e) {
        console.error(e);
        list.innerHTML = '<p style="color:red;">エラーが発生しました</p>';
    }
}

// ★追加: 編集モード切り替え & 更新処理
async function toggleUserEdit(btn, uid) {
    const row = document.getElementById(`row-${uid}`);
    if (!row) return;

    // 対象の入力フィールドを取得
    const inputs = row.querySelectorAll('.edit-input');
    
    if (btn.textContent === "変更") {
        // --- 編集モードへ ---
        inputs.forEach(input => {
            input.disabled = false;
            input.style.backgroundColor = "#fff";
            input.style.border = "1px solid #007bff";
        });
        btn.textContent = "更新";
        btn.style.backgroundColor = "#28a745"; // 緑色
        
    } else {
        // --- 保存処理 ---
        if(!confirm("この内容で更新しますか？")) return;

        const newData = {};
        
        // 各inputから値を取得してデータ構築
        inputs.forEach(input => {
            const name = input.name;
            const val = input.value.trim();

            if (name === 'groups') {
                // 配列に変換 (空文字除去)
                newData[name] = val.split(',').map(s => s.trim()).filter(s => s);
            } else if (name.startsWith('rate')) {
                // 数値変換
                newData[name] = val ? parseInt(val) : 0;
            } else {
                // 文字列そのまま
                newData[name] = val;
            }
        });

        try {
            await db.collection('users').doc(uid).update(newData);
            alert("更新しました");
            
            // 表示モードに戻す (リロードすると描画がリセットされるのでrefreshAllUsersを呼ぶ)
            refreshAllUsers();
            
        } catch(e) {
            console.error(e);
            alert("更新エラー: " + e.message);
        }
    }
}

async function loadRegisteredFaces() {
    registeredFaces = [];
    
    // 指定コレクションから読み込むヘルパー関数
    const loadFrom = async (colName) => {
        try {
            const snapshot = await db.collection(colName).get();
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
                             // コレクション名を保持しておく
                             registeredFaces.push({ 
                                 docId: doc.id, 
                                 label: data.label, 
                                 thumbnail: data.thumbnail || null, 
                                 descriptor: float32,
                                 collection: colName 
                             });
                         }
                     } catch(e) {}
                }
            });
        } catch (e) { console.error(`Error loading ${colName}:`, e); }
    };

    // web_faces と faces の両方を読み込む
    await Promise.all([loadFrom('faces'), loadFrom('web_faces')]);
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
    const listEl = document.getElementById('requestList');
    if(!listEl) return;
    listEl.innerHTML = '<p>読み込み中...</p>';
    
    try {
        const snapshot = await db.collection('auth_requests')
            .where('status', '==', 'pending')
            .orderBy('requestTimestamp', 'desc')
            .get();
            
        listEl.innerHTML = '';
        if (snapshot.empty) { 
            listEl.innerHTML = '<p>承認待ちのリクエストはありません</p>'; 
            return; 
        }

        snapshot.forEach(doc => {
            const data = doc.data();
            const date = data.requestTimestamp ? data.requestTimestamp.toDate().toLocaleString() : '---';
            const isLateLabel = data.isLate ? '<span style="color:red; font-weight:bold; margin-left:5px;">(遅刻申請)</span>' : '';
            
            const item = document.createElement('div');
            item.className = 'card'; // item-card クラスでも可ですが、pre_style.cssに合わせ card を使用
            item.style.padding = '10px';
            item.style.marginBottom = '10px';
            item.style.border = '1px solid #ddd';
            
            item.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <strong>${data.userName}</strong> ${isLateLabel}<br>
                        <small>${date}</small><br>
                        <span style="font-size:0.8em; color:#666;">Type: ${data.authType}</span>
                    </div>
                    <div>
                        <button class="btn-primary" onclick="openAuthModal('${doc.id}', '${data.userName}', '${data.authType}')">認証へ</button>
                        <button class="btn-danger" onclick="rejectRequest('${doc.id}')" style="margin-left:5px;">却下</button>
                    </div>
                </div>
            `;
            listEl.appendChild(item);
        });
    } catch(e) { 
        console.error(e);
        listEl.innerHTML = '<p>エラーが発生しました</p>'; 
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
    const listEl = document.getElementById('reportList');
    if(!listEl) return;
    listEl.innerHTML = '<p>読み込み中...</p>';
    
    try {
        const snapshot = await db.collection('absence_reports').orderBy('timestamp', 'desc').limit(50).get();
        listEl.innerHTML = '';
        if (snapshot.empty) { listEl.innerHTML = '<p>届出はありません</p>'; return; }
        
        snapshot.forEach(doc => {
            const d = doc.data();
            // 日付フォーマットの安全な処理
            let periodStr = "日付不明";
            if (d.startDate) {
                const s = d.startDate.toDate().toLocaleString();
                const e = d.endDate ? d.endDate.toDate().toLocaleString() : '';
                periodStr = e ? `${s} 〜 ${e}` : s;
            }

            const statusLabel = { 'pending':'未承認', 'approved':'承認済', 'confirm':'要確認', 'rejected':'否認' }[d.status] || d.status;
            let badgeColor = d.status==='approved'?"#007bff":d.status==='confirm'?"#ffc107":d.status==='rejected'?"#dc3545":"#666";
            
            const div = document.createElement('div');
            div.className = 'card';
            div.style.padding = '0'; // 内部でパディング調整
            div.style.marginBottom = '10px';
            div.style.border = '1px solid #ddd';
            div.style.overflow = 'hidden';

            div.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; background-color:#f8f9fa; padding:10px; border-bottom:1px solid #ddd;">
                    <strong>${d.userName}</strong>
                    <span style="background:${badgeColor}; color:white; padding:2px 8px; border-radius:4px; font-size:0.8em;">${statusLabel}</span>
                </div>
                <div style="padding:10px;">
                    <div style="font-size:0.9em; margin-bottom:5px;">
                        <span style="color:#007bff; font-weight:bold;">[${d.type === 'absence' ? '欠席' : (d.type === 'late' ? '遅刻' : d.type)}]</span> <br>
                        期間: <b>${periodStr}</b><br>
                        理由: ${d.reason || 'なし'}
                    </div>
                    ${d.attachment ? `<div style="margin:5px 0;"><a href="${d.attachment}" target="_blank"><img src="${d.attachment}" style="max-height:80px; border:1px solid #ccc;"></a></div>` : ''}
                    <div style="text-align:right; margin-top:10px;">
                        <button onclick="updateReportStatus('${doc.id}','approved')" style="padding:5px 10px; font-size:0.8em; background:#007bff; color:white; border:none; border-radius:4px; margin-right:5px; cursor:pointer;">承認</button>
                        <button onclick="updateReportStatus('${doc.id}','confirm')" style="padding:5px 10px; font-size:0.8em; background:#ffc107; color:black; border:none; border-radius:4px; margin-right:5px; cursor:pointer;">確認</button>
                        <button onclick="updateReportStatus('${doc.id}','rejected')" style="padding:5px 10px; font-size:0.8em; background:#dc3545; color:white; border:none; border-radius:4px; cursor:pointer;">否認</button>
                    </div>
                </div>
            `;
            listEl.appendChild(div);
        });
    } catch(e) { 
        console.error(e);
        listEl.innerHTML = '<p>読み込みエラー</p>'; 
    }
}

async function updateReportStatus(docId, st) {
    if(!confirm('ステータスを変更しますか？')) return;
    try {
        await db.collection('absence_reports').doc(docId).update({ status: st });
        refreshReportList();
    } catch(e) { alert("更新エラー: " + e.message); }
}

async function refreshRecurringList() {
    const list = document.getElementById('recurringList');
    if(!list) return;
    list.innerHTML = "読み込み中...";
    
    try {
        // コレクション名を正しいものに修正 (recurring_absence_applications)
        const snap = await db.collection('recurring_absence_applications')
            .where('status', '==', 'pending')
            .get();
        
        list.innerHTML = "";
        if(snap.empty) { list.innerHTML = "<p>申請はありません</p>"; return; }

        snap.forEach(doc => {
            const d = doc.data();
            const div = document.createElement('div');
            div.className = 'card';
            div.style.padding = '10px';
            div.style.marginBottom = '15px';
            div.style.border = '1px solid #ddd';

            // 簡易カレンダー(グリッド)の生成
            const weekDays = ['月', '火', '水', '木', '金', '土'];
            let gridHtml = `<div style="overflow-x:auto;"><table class="schedule-table" id="sched-${doc.id}" style="width:100%; border-collapse:collapse; font-size:0.8em; text-align:center;">
                <thead><tr style="background:#f0f0f0;"><th style="border:1px solid #ccc; padding:4px;"></th>`;
            weekDays.forEach(w => gridHtml += `<th style="border:1px solid #ccc; padding:4px;">${w}</th>`);
            gridHtml += `</tr></thead><tbody>`;

            // 1行目: 曜日全休選択行
            gridHtml += `<tr><td style="border:1px solid #ccc; padding:4px; font-weight:bold;">全休</td>`;
            weekDays.forEach(w => {
                gridHtml += `<td style="border:1px solid #ccc; padding:4px;"><input type="checkbox" class="day-chk" data-day="${w}" onchange="toggleDayColumn(this, '${doc.id}', '${w}')"></td>`;
            });
            gridHtml += `</tr>`;

            // 2~8行目: 時限 (1-7)
            for(let p=1; p<=7; p++) {
                gridHtml += `<tr><td style="border:1px solid #ccc; padding:4px;">${p}</td>`;
                weekDays.forEach(w => {
                    gridHtml += `<td style="border:1px solid #ccc; padding:4px;"><input type="checkbox" class="period-chk p-${w}" data-day="${w}" data-period="${p}" onchange="togglePeriodCell(this)"></td>`;
                });
                gridHtml += `</tr>`;
            }
            gridHtml += `</tbody></table></div>`;

            // 画像表示用のスタイル調整
            const imgHtml = d.image ? `<img src="${d.image}" style="max-width:100%; max-height:300px; margin:10px 0; border:1px solid #ccc; display:block;">` : '<p>画像なし</p>';

            div.innerHTML = `
                <div>
                    <strong style="font-size:1.1em;">${d.userName}</strong> <span style="color:#666;">(${d.semester || '期間不明'})</span><br>
                    ${imgHtml}
                    <p style="font-size:0.85em; color:#666; background:#fff3cd; padding:5px;">
                        画像(時間割)を確認し、欠席となる曜日(全休)または時限にチェックを入れてください。<br>
                        ※チェックした部分は「定期欠席」として登録されます。
                    </p>
                    ${gridHtml}
                </div>
                <div style="margin-top:10px; text-align:right;">
                    <button onclick="approveRecurring('${doc.id}')" class="btn-primary">承認・保存</button>
                    <button onclick="rejectRecurring('${doc.id}')" class="btn-danger" style="margin-left:5px;">却下</button>
                </div>
            `;
            list.appendChild(div);
        });
    } catch(e) {
        console.error(e);
        list.innerHTML = "<p>読み込みエラー</p>";
    }
}

// 関連ヘルパー関数
async function approveRecurring(docId) {
    if(!confirm("この内容で承認・保存しますか？")) return;

    const table = document.getElementById(`sched-${docId}`);
    if(!table) return;

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

    try {
        await db.collection('recurring_absence_applications').doc(docId).update({
            status: 'approved',
            data: dataString,
            approvedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert("承認しました");
        refreshRecurringList();
    } catch(e) { alert("エラー: " + e.message); }
}

async function rejectRecurring(docId) {
    if(!confirm("この申請を却下しますか？")) return;
    try {
        await db.collection('recurring_absence_applications').doc(docId).update({
            status: 'rejected',
            rejectedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        refreshRecurringList();
    } catch(e) { alert("エラー: " + e.message); }
}

function toggleDayColumn(checkbox, docId, day) {
    const table = document.getElementById(`sched-${docId}`);
    const cells = table.querySelectorAll(`.p-${day}`);
    const isChecked = checkbox.checked;
    
    // 曜日列のセル背景色を変更 (親のtdの背景を変える)
    cells.forEach(el => {
        const td = el.parentElement;
        if(isChecked) {
            td.style.backgroundColor = "#ccc";
            el.disabled = true; // 全休なら個別は無効化してもよい
        } else {
            td.style.backgroundColor = "";
            el.disabled = false;
        }
    });
    // チェックボックス自体の親セルも色変え
    checkbox.parentElement.style.backgroundColor = isChecked ? "#ccc" : "";
}

function togglePeriodCell(checkbox) {
    checkbox.parentElement.style.backgroundColor = checkbox.checked ? "#ccc" : "";
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

// --- 修正: 活動場所リスト (イベント制御の完全分離版) ---
function populateInfoLists() {
    const select = document.getElementById('campusSelect');
    if (select) {
        select.innerHTML = '<option value="">キャンパスを選択</option>';
        registeredCampuses.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.innerText = c.name;
            select.appendChild(opt);
        });
    }

    const hierList = document.getElementById('hierarchyList');
    if (!hierList) return;

    hierList.innerHTML = '';

    // --- 一括操作ボタン ---
    const controls = document.createElement('div');
    controls.style.cssText = "padding: 0 0 10px 0; border-bottom: 1px solid #ddd; margin-bottom: 10px; text-align: right;";
    
    const delAllBtn = document.createElement('button');
    delAllBtn.className = "btn-danger";
    delAllBtn.textContent = "選択したキャンパスを削除";
    delAllBtn.style.cssText = "padding:5px 10px; font-size:0.9em;";
    delAllBtn.onclick = () => deleteSelectedItems('campuses');
    controls.appendChild(delAllBtn);
    hierList.appendChild(controls);

    if (registeredCampuses.length === 0) {
        hierList.innerHTML += '<p style="text-align:center; color:#666;">キャンパスが登録されていません</p>';
        return;
    }

    // --- リスト生成 ---
    registeredCampuses.forEach(campus => {
        const areas = registeredGpsAreas.filter(a => a.campusId === campus.id);

        // 1. 外枠
        const wrapper = document.createElement('div');
        wrapper.className = 'settings-details-wrapper'; 
        wrapper.style.cssText = "margin-bottom: 15px; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; background: #fff; text-align: left;";

        // 2. ヘッダー
        const header = document.createElement('div');
        header.style.cssText = `
            display: grid; 
            grid-template-columns: auto 1fr auto auto; 
            align-items: center; 
            gap: 15px; 
            background: #f8f9fa; 
            padding: 12px 15px; 
            border-bottom: 1px solid #eee;
            user-select: none;
            position: relative;
        `;
        
        const contentId = `content-${campus.id}`;
        const arrowId = `arrow-${campus.id}`;

        // [左] チェックボックス
        const campChk = document.createElement('input');
        campChk.type = "checkbox";
        campChk.className = "chk-campus";
        campChk.value = campus.id;
        campChk.title = "削除選択";
        // ★修正: pointer-events: auto を強制し、z-indexを高くする
        campChk.style.cssText = "transform:scale(1.3); cursor:pointer; margin:0; position:relative; z-index:100; pointer-events: auto;";

        // [中] テキスト情報 (ここをクリックした時だけ開閉させる)
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = "min-width: 0; display:flex; align-items:center; flex-wrap:wrap; gap:10px; cursor:pointer;";
        infoDiv.innerHTML = `
            <span style="font-weight:bold; font-size:1.1em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">🏢 ${campus.name}</span>
            <span style="background:#eee; padding:2px 8px; border-radius:10px; font-size:0.8em; color:#555; white-space:nowrap;">${areas.length}箇所</span>
        `;
        infoDiv.onclick = () => toggleAccordionDiv(contentId, arrowId);

        // [右1] 削除ボタン
        const campDelBtn = document.createElement('button');
        campDelBtn.className = "btn-danger";
        campDelBtn.textContent = "削除";
        // ★修正: pointer-events: auto を強制
        campDelBtn.style.cssText = "padding:4px 10px; font-size:0.8em; white-space:nowrap; flex-shrink:0; position:relative; z-index:100; pointer-events: auto;";
        campDelBtn.onclick = (e) => {
            e.stopPropagation(); // 念のため
            deleteItem('campuses', campus.id);
        };

        // [右2] 矢印アイコン (ここをクリックしても開閉させる)
        const arrowSpan = document.createElement('span');
        arrowSpan.id = arrowId;
        arrowSpan.innerHTML = "&#9660;"; 
        arrowSpan.style.cssText = "font-size:0.8em; color:#666; width:1.5em; text-align:center; transition: transform 0.2s; cursor:pointer;";
        arrowSpan.onclick = () => toggleAccordionDiv(contentId, arrowId);

        header.appendChild(campChk);
        header.appendChild(infoDiv);
        header.appendChild(campDelBtn);
        header.appendChild(arrowSpan);

        // 3. コンテンツエリア
        const content = document.createElement('div');
        content.id = contentId;
        content.className = 'details-content'; 
        content.style.cssText = "padding: 15px; background: #fff; display: block;"; 

        if (areas.length > 0) {
            const areaActionDiv = document.createElement('div');
            areaActionDiv.style.cssText = 'display:flex; justify-content:flex-end; gap:10px; margin-bottom:10px; border-bottom:1px solid #eee; padding-bottom:5px;';
            
            const btnSelDel = document.createElement('button');
            btnSelDel.className = "btn-danger";
            btnSelDel.textContent = "エリア選択削除";
            btnSelDel.style.cssText = "padding:5px 10px; font-size:0.9em;";
            btnSelDel.onclick = () => deleteSelectedAreas(campus.id);

            const btnAllDel = document.createElement('button');
            btnAllDel.className = "btn-danger";
            btnAllDel.textContent = "エリア全削除";
            btnAllDel.style.cssText = "padding:5px 10px; font-size:0.9em;";
            btnAllDel.onclick = () => deleteAllAreasInCampus(campus.id);

            areaActionDiv.appendChild(btnSelDel);
            areaActionDiv.appendChild(btnAllDel);
            content.appendChild(areaActionDiv);

            const grid = document.createElement('div');
            grid.style.cssText = "display:flex; flex-direction:column; gap:8px;";

            areas.forEach(area => {
                const row = document.createElement('div');
                row.className = 'list-item-row nested-area';
                row.style.cssText = `
                    display: grid; 
                    grid-template-columns: auto 1fr auto; 
                    align-items: center; 
                    gap: 10px;
                    padding: 8px 10px; 
                    border: 1px solid #ddd; 
                    border-radius: 6px;
                    background-color: ${area.isActive ? '#e6ffec' : '#fff'};
                `;

                // [左] エリアチェックボックス
                const areaChk = document.createElement('input');
                areaChk.type = "checkbox";
                areaChk.className = `chk-area-${campus.id}`;
                areaChk.value = area.name;
                // ★修正: pointer-events: auto を強制
                areaChk.style.cssText = "transform:scale(1.2); margin:0; cursor:pointer; position:relative; z-index:100; pointer-events: auto;";

                // [中] エリア情報
                const areaInfo = document.createElement('div');
                areaInfo.style.cssText = "min-width: 0; display:flex; flex-direction:column;";
                areaInfo.innerHTML = `
                    <div style="font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">📍 ${area.name}</div>
                    <div style="font-size:0.75em; color:#666; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        Lat:${area.lat.toFixed(4)}, Lon:${area.lon.toFixed(4)}
                    </div>
                `;

                // [右] ボタン群
                const btnGroup = document.createElement('div');
                btnGroup.style.cssText = "display:flex; gap:5px; white-space:nowrap;";

                const toggleBtn = document.createElement('button');
                toggleBtn.textContent = area.isActive ? '有効' : '無効';
                // ★修正: pointer-events: auto を強制
                toggleBtn.style.cssText = `padding:4px 8px; font-size:0.8em; border:1px solid #ccc; background:${area.isActive?'#28a745':'#f8f9fa'}; color:${area.isActive?'white':'black'}; border-radius:4px; cursor:pointer; position:relative; z-index:100; pointer-events: auto;`;
                toggleBtn.onclick = () => toggleAreaActive(area.name, area.isActive);

                const delBtn = document.createElement('button');
                delBtn.textContent = "削除";
                // ★修正: pointer-events: auto を強制
                delBtn.style.cssText = "padding:4px 8px; font-size:0.8em; background:#dc3545; color:white; border:none; border-radius:4px; cursor:pointer; position:relative; z-index:100; pointer-events: auto;";
                delBtn.onclick = () => deleteItem('gps_areas', area.name);

                btnGroup.appendChild(toggleBtn);
                btnGroup.appendChild(delBtn);

                row.appendChild(areaChk);
                row.appendChild(areaInfo);
                row.appendChild(btnGroup);
                grid.appendChild(row);
            });
            content.appendChild(grid);
        } else {
            content.innerHTML = '<p style="color:#888; text-align:center; padding:10px;">エリア未登録</p>';
        }

        wrapper.appendChild(header);
        wrapper.appendChild(content);
        hierList.appendChild(wrapper);
    });

    populateFaceList();
}

// 開閉ヘルパー
window.toggleAccordionDiv = function(contentId, arrowId) {
    const content = document.getElementById(contentId);
    const arrow = document.getElementById(arrowId);
    if (!content) return;
    
    if (content.style.display === 'none') {
        content.style.display = 'block';
        if(arrow) arrow.innerHTML = "&#9660;"; 
    } else {
        content.style.display = 'none';
        if(arrow) arrow.innerHTML = "&#9654;"; 
    }
};

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
        
        // どちらのコレクションか判別用ラベル
        const sourceLabel = f.collection === 'web_faces' 
            ? '<span style="color:#007bff; font-size:0.8em; margin-left:5px;">(Web)</span>' 
            : '<span style="color:#28a745; font-size:0.8em; margin-left:5px;">(App)</span>';
        
        // 削除ボタンで正しいコレクションを指定できるようにする
        // 複数選択削除用に data-collection 属性を付与
        div.innerHTML = `
            <div class="checkbox-wrapper">
                <input type="checkbox" class="chk-face" value="${f.docId}" data-collection="${f.collection}">
                <strong>${f.label}</strong> ${sourceLabel}
            </div>
            <button class="btn-danger" onclick="deleteItem('${f.collection}', '${f.docId}')">削除</button>
        `;
        el.appendChild(div);
    });
}

async function deleteItem(collection, id) {
    if(!confirm('削除しますか？')) return;
    await db.collection(collection).doc(id).delete();
    reloadAllData();
}

async function deleteSelectedItems(type) {
    if (type === 'campuses') {
         let inputs = document.querySelectorAll('.chk-campus:checked');
         if (inputs.length === 0) return alert("選択されていません");
         if (!confirm(`${inputs.length}件のデータを削除しますか？`)) return;
         const batch = db.batch();
         inputs.forEach(input => { batch.delete(db.collection('campuses').doc(input.value)); });
         await batch.commit();
         reloadAllData();
         
    } else if (type === 'faces') {
        let inputs = document.querySelectorAll('.chk-face:checked');
        if (inputs.length === 0) return alert("選択されていません");
        if (!confirm(`${inputs.length}件の顔データを削除しますか？`)) return;

        const batch = db.batch();
        inputs.forEach(input => { 
            // data-collection 属性から削除対象のコレクションを取得 (デフォルトは faces)
            const col = input.dataset.collection || 'faces';
            batch.delete(db.collection(col).doc(input.value)); 
        });
        await batch.commit();
        reloadAllData();
    }
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
    if (!confirm("強制的に「貸出可」に戻しますか？\n(現在貸出中のユーザー情報は削除され、履歴は返却済になります)")) return;
    
    try {
        const eqRef = db.collection('equipments').doc(eqId);
        const doc = await eqRef.get();
        
        if (!doc.exists) return;
        const data = doc.data();

        const batch = db.batch();

        // 1. 備品情報の更新 (貸出情報削除)
        batch.update(eqRef, {
            status: 'available',
            currentLoan: firebase.firestore.FieldValue.delete()
        });

        // 2. ユーザー情報の borrowedItems から削除
        if (data.currentLoan && data.currentLoan.userId) {
            const userRef = db.collection('users').doc(data.currentLoan.userId);
            batch.update(userRef, {
                borrowedItems: firebase.firestore.FieldValue.arrayRemove({
                    id: eqId,
                    name: data.name
                })
            });
        }

        // 3. ★追加: 該当する申請データ(equipment_requests)も 'returned' に更新
        const reqSnap = await db.collection('equipment_requests')
            .where('equipmentId', '==', eqId)
            .where('status', '==', 'approved')
            .get();
            
        reqSnap.forEach(reqDoc => {
            batch.update(reqDoc.ref, { 
                status: 'returned',
                actualReturnDate: firebase.firestore.FieldValue.serverTimestamp(),
                returnNote: '強制返却'
            });
        });

        await batch.commit();
        
        alert("強制返却処理が完了しました");
        refreshAdminEquipmentList();
        
    } catch (e) { alert("エラー: " + e.message); }
}

// --- サブタブ切り替え関数 (修正版) ---
window.switchAdminSubTab = function(subTabName) {
    // 1. 全サブタブボタンの active クラスを解除
    const btns = document.querySelectorAll('#tab-status .sub-tab');
    btns.forEach(b => b.classList.remove('active'));
    
    // 2. クリックされたボタンに active クラスを付与
    const targetBtn = document.getElementById('btn-sub-' + subTabName);
    if(targetBtn) targetBtn.classList.add('active');

    // 3. すべてのビューを非表示にする
    const views = ['auth', 'report', 'recurring', 'equipment'];
    views.forEach(v => {
        const el = document.getElementById('view-' + v);
        if(el) el.style.display = 'none';
    });

    // 4. 対象のビューを表示し、データを更新する
    const targetView = document.getElementById('view-' + subTabName);
    if(targetView) {
        targetView.style.display = 'block';

        // 各リストの更新関数を呼び出す
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
// --- 備品承認リスト取得関数 (修正版: インデックスエラー回避) ---
async function refreshEquipmentRequests() {
    const container = document.getElementById('approval-list');
    if (!container) return;

    container.innerHTML = '<p>読み込み中...</p>';
    
    try {
        // ★修正: orderBy('timestamp', 'asc') を削除し、取得後にJSでソートする
        // (複合インデックス未作成によるエラーを回避するため)
        const snap = await db.collection('equipment_requests')
            .where('status', '==', 'pending')
            .get();

        if (snap.empty) {
            container.innerHTML = "<p>承認待ちの申請はありません</p>";
            return;
        }

        // JS側でタイムスタンプ順にソート
        const docs = snap.docs.sort((a, b) => {
            const t1 = a.data().timestamp ? a.data().timestamp.toMillis() : 0;
            const t2 = b.data().timestamp ? b.data().timestamp.toMillis() : 0;
            return t1 - t2; // 古い順 (昇順)
        });

        let html = '<div style="display:flex; flex-direction:column; gap:10px;">';
        docs.forEach(doc => {
            const d = doc.data();
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
            const batch = db.batch();

            // 1. 備品マスタの状態を「貸出中」に更新
            const eqRef = db.collection('equipments').doc(data.equipmentId);
            batch.update(eqRef, {
                status: 'loaned',
                currentLoan: {
                    userId: data.userId,
                    userName: data.userName,
                    startDate: data.startDate,
                    endDate: data.endDate
                }
            });

            // 2. 申請ステータスを承認に更新
            batch.update(reqRef, { status: 'approved' });

            // 3. ★追加: ユーザー情報の borrowedItems に追加
            const userRef = db.collection('users').doc(data.userId);
            batch.update(userRef, {
                borrowedItems: firebase.firestore.FieldValue.arrayUnion({
                    id: data.equipmentId,
                    name: data.equipmentName
                })
            });

            await batch.commit();
        } else {
            await reqRef.update({ status: 'rejected' });
        }

        alert("処理しました");
        refreshEquipmentRequests();
        
        if (document.getElementById('equipment-list-admin')) refreshAdminEquipmentList();

    } catch (e) {
        alert("エラーが発生しました: " + e.message);
        console.error(e);
    }
}
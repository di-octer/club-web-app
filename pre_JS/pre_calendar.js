let checkDisplayDate = new Date();
let checkHistoryDates = [];
let checkReportRanges = [];
let checkRecurringData = [];
let displayCalDate = new Date();

async function renderCalendarGrid(targetId, ym, mode) {
    const container = document.getElementById(targetId);
    container.innerHTML = "読み込み中...";
    const [year, month] = ym.split('-').map(Number);
    
    let monthData = {};
    let acadData = {};
    let userLogs = [];
    let userReports = [];
    let userRecurringData = [];

    const weekDays = ['日','月','火','水','木','金','土'];

    // 1. 月次データ取得
    if (mode === 'preview') {
        const activityDays = {};
        document.querySelectorAll('.act-chk:checked').forEach(chk => {
            const cid = chk.dataset.cid;
            const day = parseInt(chk.value);
            if(!activityDays[cid]) activityDays[cid] = [];
            activityDays[cid].push({ day });
        });
        const previewNoAct = tempNoActivityDays.map(item => ({ ...item, date: resolveDateYear(item.date, year, false) }));
        monthData = { activityDays, events: tempEvents, noActivityDays: previewNoAct };
    } else {
        try {
            const doc = await db.collection('calendars').doc(ym).get();
            if(doc.exists) monthData = doc.data();
        } catch(e){}
    }

    // 2. 学年暦データ取得
    const acadYear = (month >= 1 && month <= 3) ? year - 1 : year;
    try {
        const adoc = await db.collection('calendar_meta').doc(`config_${acadYear}`).get();
        if(adoc.exists) acadData = adoc.data();
    } catch(e){}

    // 3. ユーザーデータセット
    if (mode === 'user' && currentUser) {
        userLogs = checkHistoryDates;
        userReports = checkReportRanges;
        userRecurringData = checkRecurringData;
    }

    // 更新日時
    const updateEl = document.getElementById('userCalUpdated');
    if (updateEl) {
        updateEl.textContent = monthData.updatedAt ? `管理者最終更新: ${monthData.updatedAt.toDate().toLocaleString()}` : "";
    }

    // グリッド生成
    const firstDay = new Date(year, month - 1, 1).getDay();
    const lastDate = new Date(year, month, 0).getDate();
    let html = `<div class="calendar-grid">`;
    weekDays.forEach(w => html += `<div class="cal-day-header">${w}</div>`);
    for(let i=0; i<firstDay; i++) html += `<div class="cal-cell" style="background:#f9f9f9;"></div>`;

    const today = new Date();
    const tY = today.getFullYear(), tM = today.getMonth(), tD = today.getDate();
    
    for(let d=1; d<=lastDate; d++) {
        const currentYMD = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const dateObj = new Date(year, month-1, d);
        const dayOfWeek = dateObj.getDay();
        const dayStr = weekDays[dayOfWeek];

        let cellClass = "cal-cell";
        let icons = "";
        
        // ★修正: バッジは4行固定
        // [0]: 休日・期間・成績発表 (休日優先確認 -> 期間上書き -> 成績発表分割)
        // [1]: 仮入部 / 総会 / 合宿 / 活動日
        // [2]: 基礎班 / 発展班 (分割可)
        // [3]: ラジオ / イベント (分割可)
        let badges = [null, null, null, null]; 

        // イベント情報の整理
        let dayEvents = [];
        if (monthData.events) {
            dayEvents = monthData.events.filter(e => isWithin(currentYMD, e));
        }

        // --- Row 0: 休日・期間・成績発表 ---
        let b0 = null;

        if (acadData) {
            // 1. まず休日判定 (後で期間によって上書きされる可能性あり)
            const holidayName = getJapaneseHolidayName(dateObj);
            if (acadData.exceptions) {
                const ex = acadData.exceptions.find(e => e.date === currentYMD);
                if (ex) {
                    if (ex.type === 'school_day') b0 = { text: '授業実施日', cls: 'badge-red' };
                    else b0 = { text: '特別休日', cls: 'badge-gray' };
                } else if (holidayName) {
                    b0 = { text: '通常休日', cls: 'badge-gray' };
                }
            } else if (holidayName) {
                b0 = { text: '通常休日', cls: 'badge-gray' };
            }

            // 2. 期間判定 (休日より優先して表示したい場合上書き)
            const setQ = (p, label, colorCls) => {
                if(p.start === currentYMD) b0 = { text: `${label}初日`, cls: `${colorCls} border-blue` };
                else if(p.end === currentYMD) b0 = { text: `${label}最終日`, cls: `${colorCls} border-red` };
            };
            if(acadData.t1_front) setQ(acadData.t1_front, '1Q', 'badge-q-pre');
            if(acadData.t1_back) setQ(acadData.t1_back, '2Q', 'badge-q-pre');
            if(acadData.t2_front) setQ(acadData.t2_front, '3Q', 'badge-q-post');
            if(acadData.t2_back) setQ(acadData.t2_back, '4Q', 'badge-q-post');

            if(acadData.periods) {
                if(isWithin(currentYMD, acadData.periods.reg1) || isWithin(currentYMD, acadData.periods.reg2)) b0 = { text: '履修登録', cls: 'badge-red' };
                if(isWithin(currentYMD, acadData.periods.sup1) || isWithin(currentYMD, acadData.periods.sup2)) b0 = { text: '集中補講', cls: 'badge-red' };
                if(isWithin(currentYMD, acadData.periods.exam1) || isWithin(currentYMD, acadData.periods.exam2)) b0 = { text: '試験', cls: 'badge-red' };
            }
            if(acadData.festivals) acadData.festivals.forEach(f => {
                if(isWithin(currentYMD, f)) b0 = { text: `文化祭`, cls: getCampusBadgeClass(f.cid) };
            });
            if(acadData.winter && isWithin(currentYMD, acadData.winter)) b0 = { text: '冬季休暇', cls: 'badge-gray' };
        }

        // 3. 成績発表判定 (あれば分割表示)
        let isGradeDay = false;
        if (acadData && acadData.periods) {
            if (isWithin(currentYMD, acadData.periods.grade1) || isWithin(currentYMD, acadData.periods.grade2)) isGradeDay = true;
        }

        if (isGradeDay) {
            if (b0) {
                // 既存バッジがある場合 -> 分割表示
                // ※b0の内容と「成績発表日」を分割
                let splitHtml = `
                    <div class="cal-badge-split ${b0.cls}">${b0.text}</div>
                    <div class="cal-badge-split badge-red">成績発表日</div>
                `;
                badges[0] = { type: 'split', html: splitHtml };
            } else {
                // ない場合 -> 単独表示
                badges[0] = { text: '成績発表日', cls: 'badge-red' };
            }
        } else {
            // 成績発表がない場合、b0をそのまま使用
            badges[0] = b0;
        }


        // --- Row 1: 仮入部 / 総会 / 合宿 / 活動日 ---
        let r1_override = null;
        const trialEvt = dayEvents.find(e => e.type === 'trial');
        const generalEvt = dayEvents.find(e => e.type === 'general');
        const campEvt = dayEvents.find(e => e.type === 'camp');
        
        // 優先度高: 総会 > 合宿 > 仮入部
        if (generalEvt) r1_override = { text: '総会日', cls: 'badge-teal-yellow' };
        else if (campEvt) r1_override = { text: '合宿', cls: 'badge-camp' };
        else if (trialEvt) r1_override = { text: '仮入部実施', cls: 'badge-trial' };

        if (r1_override) {
            badges[1] = r1_override;
        } else if (registeredCampuses.length > 0 && monthData.activityDays) {
            // 活動日分割バー生成
            let splitHtml = "";
            let isTerm = isTermPeriodFunc(currentYMD, acadData);
            let isExcl = isExcludedFunc(currentYMD, acadData);

            registeredCampuses.forEach(c => {
                let status = "none"; 
                let hasSetting = monthData.activityDays[c.id] && monthData.activityDays[c.id].some(s => s.day === dayOfWeek);
                let isBlocked = monthData.noActivityDays && monthData.noActivityDays.some(n => n.date === currentYMD && (n.cid === c.id || !n.cid));

                if (isBlocked) status = "no_act";
                else if (hasSetting && isTerm && !isExcl) status = "active";

                let cls = getCampusBadgeClass(c.id);
                if (status === "active") splitHtml += `<div class="cal-badge-split ${cls}"></div>`;
                else if (status === "no_act") splitHtml += `<div class="cal-badge-split ${cls}">無</div>`;
                else splitHtml += `<div class="cal-badge-split"></div>`;
            });
            badges[1] = { type: 'split', html: splitHtml };
        }

        // --- Row 2: 基礎班 / 発展班 (分割 or 占有) ---
        const basicEvt = dayEvents.find(e => e.type === 'dev_basic');
        const advEvt = dayEvents.find(e => e.type === 'dev_adv');

        if (basicEvt && advEvt) {
            let html2 = `
                <div class="cal-badge-split badge-dev-basic">基礎班開発</div>
                <div class="cal-badge-split badge-dev-adv">発展班開発</div>
            `;
            badges[2] = { type: 'split', html: html2 };
        } else if (basicEvt) {
            badges[2] = { text: '基礎班開発', cls: 'badge-dev-basic' };
        } else if (advEvt) {
            badges[2] = { text: '発展班開発', cls: 'badge-dev-adv' };
        }

        // --- Row 3: ラジオ / イベント (分割 or 占有) ---
        const radioEvt = dayEvents.find(e => e.type === 'radio');
        const otherEvt = dayEvents.find(e => e.type === 'event');

        if (radioEvt && otherEvt) {
            let html3 = `
                <div class="cal-badge-split badge-radio">ラジオ日</div>
                <div class="cal-badge-split badge-event">${otherEvt.title}</div>
            `;
            badges[3] = { type: 'split', html: html3 };
        } else if (radioEvt) {
            badges[3] = { text: 'ラジオ日', cls: 'badge-radio' };
        } else if (otherEvt) {
            badges[3] = { text: otherEvt.title, cls: 'badge-event' };
        }


        // --- バッジHTML生成 ---
        let badgeHtml = `<div class="badge-container">`;
        for(let r=0; r<4; r++) { // 4行ループ
            if (badges[r]) {
                if (badges[r].type === 'split') {
                    badgeHtml += `<div class="badge-row-split">${badges[r].html}</div>`;
                } else {
                    badgeHtml += `<div class="badge-row"><div class="cal-badge ${badges[r].cls}">${badges[r].text}</div></div>`;
                }
            } else {
                badgeHtml += `<div class="badge-row"></div>`;
            }
        }
        badgeHtml += `</div>`;


        // --- アイコン・ステータス判定 ---
        let isTerm = isTermPeriodFunc(currentYMD, acadData);
        let isExcl = isExcludedFunc(currentYMD, acadData);
        let isUserActivityDay = false;
        let userCampus = (userSettings && userSettings.defaultCampusId) ? userSettings.defaultCampusId : null;
        
        if (monthData.activityDays) {
            if (userCampus) {
                if (monthData.activityDays[userCampus] && monthData.activityDays[userCampus].some(s => s.day === dayOfWeek)) isUserActivityDay = true;
                if (monthData.noActivityDays && monthData.noActivityDays.some(n => n.date === currentYMD && (n.cid === userCampus || !n.cid))) isUserActivityDay = false;
            } else {
                for(const k in monthData.activityDays) {
                    let blocked = monthData.noActivityDays && monthData.noActivityDays.some(n => n.date === currentYMD && (n.cid === k || !n.cid));
                    if (!blocked && monthData.activityDays[k].some(s => s.day === dayOfWeek)) isUserActivityDay = true;
                }
            }
        }
        
        const shouldShowIcons = isTerm && !isExcl && isUserActivityDay;

        // --- セル内アイコン表示 ---
        if (mode === 'user') {
            const log = userLogs.find(l => l.getFullYear() === year && l.getMonth() + 1 === month && l.getDate() === d);
            const reports = userReports.filter(r => dateObj >= r.start && dateObj <= r.end);
            const approvedAbsence = reports.find(r => r.type === 'absence' && r.status === 'approved');
            
            let recurringStatus = null;
            if (shouldShowIcons) {
                const rec = userRecurringData.find(r => r.day === dayStr);
                if (rec) recurringStatus = (rec.periods === 'All') ? 'absent' : 'late_early';
            }

            if (log) {
                cellClass += " active-area-approved"; icons += createIcon('#28a745', '出席');
            } else if (approvedAbsence) {
                cellClass += " active-area-approved"; icons += createIcon('#800080', '欠席(承認済)');
            } else if (recurringStatus === 'absent') {
                icons += createIcon('#C71585', '定期欠席');
            } else {
                if (recurringStatus === 'late_early') icons += createIcon('#8A2BE2', '定期遅刻/早退');
                let pendingCnt = 0;
                reports.forEach(r => {
                    if (r.status === 'pending') pendingCnt++;
                    else if (r.status !== 'approved') {
                        let c = '#666'; if (r.status === 'approved') c = '#007bff'; if (r.status === 'confirm') c = '#ffc107'; if (r.status === 'rejected') c = '#dc3545';
                        icons += createIcon(c, r.type);
                    }
                });
                if (pendingCnt > 0) icons += createIcon('gray', String(pendingCnt), true);
            }
        }

        let isToday = (year === tY && month === (tM + 1) && d === tD);
        let todayStyle = isToday ? "today-circle" : "";

        html += `
            <div class="${cellClass} ${todayStyle}">
                <div style="font-weight:bold; font-size:0.9em; margin-bottom:2px; padding-left:2px;">${d}</div>
                ${badgeHtml}
                <div class="icon-container">${icons}</div>
            </div>`;
    }
    html += `</div>`;
    container.innerHTML = html;
}

async function updateTodayCampusStatus() {
    const el = document.getElementById('todayStatus');
    if (!el || !currentUser) return;
    el.innerHTML = '読み込み中...';
    
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth() + 1;
    const d = today.getDate();
    const ym = `${y}-${String(m).padStart(2,'0')}`;
    const dayOfWeek = today.getDay();
    const dayStr = ['日','月','火','水','木','金','土'][dayOfWeek];
    const ymd = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

    try {
        let monthData = {};
        const cDoc = await db.collection('calendars').doc(ym).get();
        if(cDoc.exists) monthData = cDoc.data();

        let acadData = {};
        const acadYear = (m >= 1 && m <= 3) ? y - 1 : y;
        const aDoc = await db.collection('calendar_meta').doc(`config_${acadYear}`).get();
        if(aDoc.exists) acadData = aDoc.data();

        let html = '<div class="status-list">';
        let isTerm = isTermPeriodFunc(ymd, acadData);
        let isExcl = isExcludedFunc(ymd, acadData);

        registeredCampuses.forEach((c, idx) => {
            let statusText = "活動なし";
            let statusClass = "no-act"; 

            let hasSetting = monthData.activityDays && monthData.activityDays[c.id] && monthData.activityDays[c.id].some(s => s.day === dayOfWeek);
            let isBlocked = monthData.noActivityDays && monthData.noActivityDays.some(n => n.date === ymd && (n.cid === c.id || !n.cid));
            
            let isActivityDay = isTerm && !isExcl && hasSetting && !isBlocked;

            if (isActivityDay) {
                statusText = "未";
                statusClass = "active-late";

                // 出席状況の判定
                const log = checkHistoryDates.find(l => l.getFullYear()===y && l.getMonth()+1===m && l.getDate()===d);
                const approvedAbsence = checkReportRanges.find(r => today >= r.start && today <= r.end && r.type === 'absence' && r.status === 'approved');
                
                let recStatus = null;
                const rec = checkRecurringData.find(r => r.day === dayStr);
                if (rec) recStatus = (rec.periods === 'All') ? 'absent' : 'late_early';

                if (log) {
                    statusText = "出席 ✅";
                    statusClass = "active-ok";
                } else if (approvedAbsence) {
                    statusText = "欠席(届出済)";
                    statusClass = "active-abs";
                } else if (recStatus === 'absent') {
                    statusText = "定期欠席";
                    statusClass = "active-abs";
                } else if (isLateAuth) {
                    statusText = "遅刻状態";
                    statusClass = "active-late";
                }
            }

            // ★修正: キャンパスインデックスに応じた枠色を設定
            // CSSクラス (border-c1, border-c2 等) の色定義に対応
            let borderColor = '#999'; // デフォルト(グレー)
            if (idx === 0) borderColor = 'green';
            else if (idx === 1) borderColor = 'blue';
            else if (idx === 2) borderColor = 'red';
            else if (idx === 3) borderColor = '#00bcd4'; // Cyan
            else borderColor = '#e91e63'; // Magenta

            // border-widthを少し太くし、色を明示的に指定して上書きする
            html += `<div class="status-row ${statusClass}" style="border: 2px solid ${borderColor};">
                <span>${c.name}</span>
                <span>${statusText}</span>
            </div>`;
        });
        html += '</div>';
        
        el.innerHTML = html;
        el.className = ""; 
        el.style.backgroundColor = "transparent";
        el.style.padding = "0";

    } catch(e) {
        console.error(e);
        el.innerHTML = "ステータス取得エラー";
    }
}

async function checkAttendance() {
    if (!currentUser) return;
    const name = currentUser.displayName;
    const resultEl = document.getElementById('resultArea');
    if(resultEl) resultEl.style.display = 'block';
    try {
        const logSnap = await db.collection('attendance_logs').where('userName', '==', name).get();
        checkHistoryDates = [];
        logSnap.forEach(doc => checkHistoryDates.push(doc.data().timestamp.toDate()));

        const reportSnap = await db.collection('absence_reports').where('userName', '==', name).get();
        checkReportRanges = [];
        reportSnap.forEach(doc => {
            const d = doc.data();
            if(d.startDate) {
                let s = d.startDate.toDate(); let e = d.endDate ? d.endDate.toDate() : s;
                checkReportRanges.push({ status: d.status, type: d.type, start: new Date(s.setHours(0,0,0,0)), end: new Date(e.setHours(23,59,59,999)) });
            }
        });

        checkRecurringData = [];
        const recSnap = await db.collection('recurring_absence_applications')
            .where('userId', '==', currentUser.uid)
            .where('status', '==', 'approved').get();
        recSnap.forEach(d => {
            const val = d.data();
            if(val.data && typeof val.data === 'string') {
                val.data.split('|').forEach(p => {
                    const [day, periods] = p.split(':');
                    checkRecurringData.push({day, periods});
                });
            }
        });
        
        checkDisplayDate = new Date();
        renderCalendar();
        
        // ★独立させた今日のステータス更新を呼び出し
        updateTodayCampusStatus();
        
    } catch(e) { console.error(e); }
}

function renderCalendar() {
    const y = checkDisplayDate.getFullYear();
    const m = checkDisplayDate.getMonth() + 1;
    const ym = `${y}-${String(m).padStart(2,'0')}`;
    document.getElementById('calendarTitle').textContent = `${y}年 ${m}月`;
    renderCalendarGrid('calendarGrid', ym, 'user');
}

function moveUserCalendar(offset) {
    displayCalDate.setMonth(displayCalDate.getMonth() + offset);
    updateUserCalendarTitle();
    renderUserCalendar();
}

function previewCalendar() {
    const ym = document.getElementById('targetMonth').value;
    if(ym) renderCalendarGrid('adminCalPreview', ym, 'preview');
}

function getJapaneseHolidayName(date) {
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const ymd = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

    // 固定祝日
    const fixed = {
        '01-01': '元日', '02-11': '建国記念', '02-23': '天皇誕生日', '04-29': '昭和の日',
        '05-03': '憲法記念', '05-04': 'みどりの日', '05-05': 'こどもの日',
        '08-11': '山の日', '11-03': '文化の日', '11-23': '勤労感謝'
    };
    if (fixed[`${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`]) return fixed[`${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`];

    // ハッピーマンデー (成人の日, 海の日, 敬老の日, スポーツの日)
    const getNthMonday = (year, month, n) => {
        let date = new Date(year, month - 1, 1);
        let add = (8 - date.getDay()) % 7;
        return 1 + add + (n - 1) * 7;
    };
    if (m === 1 && d === getNthMonday(y, 1, 2)) return '成人の日';
    if (m === 7 && d === getNthMonday(y, 7, 3)) return '海の日';
    if (m === 9 && d === getNthMonday(y, 9, 3)) return '敬老の日';
    if (m === 10 && d === getNthMonday(y, 10, 2)) return 'スポーツ';

    // 春分・秋分 (簡易計算)
    const vernal = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    const autumn = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
    if (m === 3 && d === vernal) return '春分の日';
    if (m === 9 && d === autumn) return '秋分の日';

    return null;
}

function getCampusName(cid) {
    const c = registeredCampuses.find(x => x.id === cid);
    return c ? c.name : cid;
}

function getCampusBadgeClass(cid) {
    // 登録順などで色分け (簡易実装)
    const idx = registeredCampuses.findIndex(x => x.id === cid);
    if (idx === 0) return 'badge-beige border-c1'; // Green
    if (idx === 1) return 'badge-beige border-c2'; // Blue
    if (idx === 2) return 'badge-beige border-c3'; // Red
    if (idx === 3) return 'badge-beige border-cy'; // Cyan
    return 'badge-beige border-cm'; // Magenta
}

function isTermPeriodFunc(ymd, acad) {
    if (!acad) return false;
    // 学期 (1Q~4Q)
    const terms = [acad.t1_front, acad.t1_back, acad.t2_front, acad.t2_back];
    if (terms.some(p => isWithin(ymd, p))) return true;
    // 授業実施日例外
    if (acad.exceptions && acad.exceptions.some(e => e.date === ymd && e.type === 'school_day')) return true;
    return false;
}

function isExcludedFunc(ymd, acad) {
    if (!acad) return false;
    // 文化祭
    if (acad.festivals && acad.festivals.some(f => isWithin(ymd, f))) return true;
    // 冬季休暇
    if (acad.winter && isWithin(ymd, acad.winter)) return true;
    // 集中補講 (期間指定の場合)
    if (acad.periods && (isWithin(ymd, acad.periods.sup1) || isWithin(ymd, acad.periods.sup2))) return true;
    // 休日例外
    if (acad.exceptions && acad.exceptions.some(e => e.date === ymd && e.type === 'holiday')) return true;
    // 通常休日 (祝日) - 授業実施日でない場合
    const isSchoolDay = acad.exceptions && acad.exceptions.some(e => e.date === ymd && e.type === 'school_day');
    if (!isSchoolDay && getJapaneseHolidayName(new Date(ymd))) return true;
    
    return false;
}

function createIcon(color, title, isText=false) {
    if(isText) return `<div style="background:${color};color:white;font-size:9px;width:14px;height:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;" title="${title}">${title}</div>`;
    return `<div style="background:${color};width:14px;height:14px;border-radius:50%;" title="${title}"></div>`;
}
function isWithin(ymd, period) { return period && ymd >= period.start && ymd <= period.end; }

function changeMonth(offset) {
    checkDisplayDate.setMonth(checkDisplayDate.getMonth() + offset);
    renderCalendar();
}

async function initUserCalendarPage() {
    updateUserCalendarTitle();
    renderUserCalendar();
}

function updateUserCalendarTitle() {
    // displayCalDate は pre_calendar.js の冒頭で定義済みと想定
    const y = displayCalDate.getFullYear();
    const m = displayCalDate.getMonth() + 1;
    const el = document.getElementById('userCalTitle');
    if(el) el.textContent = `${y}年 ${m}月`;
}

function renderUserCalendar() {
    const y = displayCalDate.getFullYear();
    const m = displayCalDate.getMonth() + 1;
    const ym = `${y}-${String(m).padStart(2,'0')}`;
    renderCalendarGrid('userCalGrid', ym, 'user');
}
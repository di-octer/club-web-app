async function initSettingsPage() {
    if (!currentUser) return;

    const s = userSettings || {};
    
    document.getElementById('setAuthMethod').value = s.authMethod || "";
    document.getElementById('setNewsOrder').value = s.newsOrder || "newest";
    document.getElementById('setNewsDefaultTab').value = s.newsDefaultTab || "trend";
    document.getElementById('setNewsDefaultCount').value = s.newsDefaultCount || 5;
    document.getElementById('setNewsMaxCount').value = s.newsMaxCount || 20;

    const currentIcon = s.customIcon || currentUser.photoURL;
    document.getElementById('previewIcon').src = currentIcon || "https://via.placeholder.com/50";
    document.getElementById('setDisplayName').value = currentUser.displayName || "";
    document.getElementById('manualInterests').value = (s.manualInterests || []).join(', ');
    document.getElementById('manualTechStack').value = (s.manualTechStack || []).join(', ');
    document.getElementById('profileText').value = s.profileText || "";

    renderAutoTags('autoInterestsList', s.autoInterests || []);
    renderAutoTags('autoTechList', s.autoTechStack || []);

    const campSelect = document.getElementById('setDefaultCampus');
    registeredCampuses.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id; opt.innerText = c.name;
        campSelect.appendChild(opt);
    });
    campSelect.value = s.defaultCampusId || "";

    loadApprovedRecurring();
}

function renderAutoTags(containerId, tags) {
    const container = document.getElementById(containerId);
    container.innerHTML = "";
    if (!tags || tags.length === 0) {
        container.innerHTML = '<span style="color:#999; font-size:0.8em;">データなし</span>';
        return;
    }
    tags.forEach(tag => {
        const span = document.createElement('span');
        span.className = 'tag-badge';
        span.style.cssText = "display:inline-block; background:#e0e0e0; border-radius:12px; padding:2px 8px; margin:2px; font-size:0.8em;";
        span.innerHTML = `${tag} <span onclick="removeAutoTag('${containerId}', '${tag}')" style="cursor:pointer; color:#888; margin-left:5px;">×</span>`;
        container.appendChild(span);
    });
}

async function removeAutoTag(type, tag) {
    if(!confirm(`「${tag}」を削除しますか？\n(今後半年間は自動追加されません)`)) return;
    
    const field = (type === 'autoInterestsList') ? 'autoInterests' : 'autoTechStack';
    const hiddenField = (type === 'autoInterestsList') ? 'hiddenInterests' : 'hiddenTechStack';

    const currentList = userSettings[field] || [];
    const newList = currentList.filter(t => t !== tag);
    
    const until = new Date();
    until.setMonth(until.getMonth() + 6);

    const hiddenItem = { tag: tag, until: firebase.firestore.Timestamp.fromDate(until) };

    try {
        await db.collection('users').doc(currentUser.uid).update({
            [field]: newList,
            [hiddenField]: firebase.firestore.FieldValue.arrayUnion(hiddenItem)
        });
        await loadUserSettings(currentUser.uid);
        renderAutoTags(type, newList);
    } catch(e) { alert("更新エラー: " + e.message); }
}

async function resetToDiscordIcon() {
    document.getElementById('previewIcon').src = currentUser.photoURL;
    document.getElementById('iconUploader').value = ""; 
}

async function saveSettings() {
    if (!currentUser) return;
    const uid = currentUser.uid;

    const authMethod = document.getElementById('setAuthMethod').value;
    const newsOrder = document.getElementById('setNewsOrder').value;
    const newsDefaultTab = document.getElementById('setNewsDefaultTab').value;
    const newsDefaultCount = parseInt(document.getElementById('setNewsDefaultCount').value);
    const newsMaxCount = parseInt(document.getElementById('setNewsMaxCount').value);

    const iconInput = document.getElementById('iconUploader');
    let customIcon = userSettings.customIcon || null;
    
    if (iconInput.files && iconInput.files[0]) {
        customIcon = await toBase64(iconInput.files[0]);
    } else if (document.getElementById('previewIcon').src === currentUser.photoURL) {
        customIcon = null; 
    }
    const newDisplayName = document.getElementById('setDisplayName').value.trim();
    const manualInterests = document.getElementById('manualInterests').value.split(',').map(s => s.trim()).filter(s=>s);
    const manualTechStack = document.getElementById('manualTechStack').value.split(',').map(s => s.trim()).filter(s=>s);
    const profileText = document.getElementById('profileText').value;
    const defaultCampusId = document.getElementById('setDefaultCampus').value;
    const language = document.getElementById('setLanguage').value;

    try {
        // Firestore更新データ作成
        const updateData = {
            authMethod, newsOrder, newsDefaultTab, newsDefaultCount, newsMaxCount,
            customIcon, manualInterests, manualTechStack, profileText, defaultCampusId, language,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        // displayNameが変更されていれば追加
        if (newDisplayName && newDisplayName !== currentUser.displayName) {
            updateData.displayName = newDisplayName;
            
            // Firebase Auth側のProfileも更新しておく(推奨)
            await currentUser.updateProfile({ displayName: newDisplayName });
        }

        await db.collection('users').doc(uid).set(updateData, { merge: true });

        alert("設定を保存しました");
        location.reload(); 
    } catch(e) { alert("保存エラー: " + e.message); }
}

async function submitRecurringAbsence() {
    const semester = document.getElementById('recurringSemester').value;
    const fileInput = document.getElementById('recurringImage');
    
    if (!fileInput.files[0]) return alert("画像を選択してください");
    
    const imageBase64 = await toBase64(fileInput.files[0]);
    
    try {
        await db.collection('recurring_absence_applications').add({
            userId: currentUser.uid,
            userName: currentUser.displayName,
            semester: semester,
            image: imageBase64,
            status: 'pending',
            data: null, 
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert("提出しました。管理者の承認をお待ちください。");
        fileInput.value = "";
    } catch(e) { alert("送信エラー: " + e.message); }
}

async function loadApprovedRecurring() {
    const list = document.getElementById('approvedRecurringList');
    list.innerHTML = "読み込み中...";
    try {
        const snap = await db.collection('recurring_absence_applications')
            .where('userId', '==', currentUser.uid)
            .where('status', '==', 'approved')
            .orderBy('timestamp', 'desc')
            .get();
        
        list.innerHTML = "";
        if (snap.empty) {
            list.innerHTML = "<p>承認済みのデータはありません</p>";
            return;
        }

        snap.forEach(doc => {
            const d = doc.data();
            const div = document.createElement('div');
            div.style.border = "1px solid #ddd"; div.style.padding = "10px"; div.style.marginBottom = "5px";
            let content = `<strong>${d.semester}</strong><br>`;
            if (d.data) {
                content += `<div>不参加: ${d.data}</div>`;
            }
            content += `<img src="${d.image}" style="max-height:100px; display:block; margin-top:5px;">`;
            div.innerHTML = content;
            list.appendChild(div);
        });
    } catch(e) { console.error(e); list.innerHTML = "読み込みエラー"; }
}

function toggleFormInputs() {
    const type = document.getElementById('reportType').value;
    if (type === 'absence') {
        document.getElementById('input-date-range').style.display = 'block';
        document.getElementById('input-datetime').style.display = 'none';
    } else {
        document.getElementById('input-date-range').style.display = 'none';
        document.getElementById('input-datetime').style.display = 'block';
    }
}

async function submitReport() {
    if (!currentUser) return alert("ログインしてください");
    const type = document.getElementById('reportType').value;
    const reason = document.getElementById('reportReason').value.trim();
    const fileInput = document.getElementById('reportImage');
    if (!reason) return alert("理由を入力してください");

    let startDate = null, endDate = null;
    if (type === 'absence') {
        const s = document.getElementById('reportStartDate').value;
        startDate = new Date(s + 'T00:00:00');
        endDate = new Date(s + 'T23:59:59');
    } else {
        const dt = document.getElementById('reportDateTime').value;
        startDate = new Date(dt); endDate = new Date(dt);
    }

    let imageBase64 = null;
    if (fileInput.files[0]) imageBase64 = await toBase64(fileInput.files[0]);

    await db.collection('absence_reports').add({
        userName: currentUser.displayName, type, reason,
        startDate: firebase.firestore.Timestamp.fromDate(startDate),
        endDate: firebase.firestore.Timestamp.fromDate(endDate),
        attachment: imageBase64, status: 'pending',
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
    alert("送信しました");
}
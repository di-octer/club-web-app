let isNewsExpanded = false;
let currentNewsSlide = 0;
let touchStartX = 0;
let touchEndX = 0;

async function loadHomeNews() {
    const section = document.getElementById('news-section');
    if (!section) return;

    // 1. HTML構造の復元 (タブバーとスライドトラック)
    if (!document.getElementById('news-tab-bar')) {
        section.innerHTML = ''; 
        const tabBar = document.createElement('div');
        tabBar.id = 'news-tab-bar';
        tabBar.style.cssText = "display:flex; margin-bottom:10px; border-radius:5px; overflow:hidden;";
        tabBar.innerHTML = `
            <button id="tab-news-0" onclick="switchNewsSlide(0)" style="flex:1; padding:12px; border:none; background:#007bff; color:white; font-weight:bold; cursor:pointer;">管理者おすすめ</button>
            <button id="tab-news-1" onclick="switchNewsSlide(1)" style="flex:1; padding:12px; border:none; background:#eee; color:#333; cursor:pointer;">Qiitaトレンド</button>
        `;
        section.appendChild(tabBar);

        const track = document.createElement('div');
        track.id = 'newsTrack';
        track.className = 'news-track';
        track.style.cssText = "display:flex; transition:transform 0.4s ease; width:200%;";
        track.addEventListener('touchstart', e => touchStartX = e.changedTouches[0].screenX);
        track.addEventListener('touchend', e => {
            touchEndX = e.changedTouches[0].screenX;
            handleSwipe();
        });

        track.innerHTML = `
            <div id="slide-rec" class="news-slide" style="width:50%; padding:0 10px; box-sizing:border-box;"></div>
            <div id="slide-trend" class="news-slide" style="width:50%; padding:0 10px; box-sizing:border-box;"></div>
        `;
        section.appendChild(track);
    }

    const maxCount = (userSettings && userSettings.newsMaxCount) ? parseInt(userSettings.newsMaxCount) : 20;
    const slideRec = document.getElementById('slide-rec');
    const slideTrend = document.getElementById('slide-trend');

    // =========================================================================
    // 【プラン変更待ち】 バックエンド版 (コメントアウト中)
    // =========================================================================
    /*
    if (slideRec) slideRec.innerHTML = '<p>読み込み中...</p>';
    if (slideTrend) slideTrend.innerHTML = '<p>読み込み中...</p>';
    try {
        const doc = await db.collection('home_news').doc('feed').get();
        let recItems = [], trendItems = [];
        if (doc.exists) {
            const data = doc.data();
            const allItems = data.items || [];
            recItems = allItems.filter(i => i.type === 'admin');
            trendItems = allItems.filter(i => i.type === 'qiita');
        }
        if (recItems.length > maxCount) recItems = recItems.slice(0, maxCount);
        if (trendItems.length > maxCount) trendItems = trendItems.slice(0, maxCount);

        if (slideRec) renderNewsSlide(slideRec, "🏆 管理者おすすめ", "Qiitaトレンド ➡", recItems, 1);
        if (slideTrend) renderNewsSlide(slideTrend, "📈 Qiitaトレンド", "⬅ 管理者おすすめ", trendItems, 0);
    } catch (e) {
        console.error("Backend News Error:", e);
    }
    */
   
    // =========================================================================
    // 【暫定対応】 フロントエンド版 (プロキシ経由 & Firestore直接読み込み)
    // =========================================================================
    
    // A. 管理者おすすめ (Firestoreから直接取得)
    if (slideRec) {
        slideRec.innerHTML = '<p>読み込み中...</p>';
        try {
            const snap = await db.collection('recommended_news').orderBy('timestamp', 'desc').limit(maxCount).get();
            let items = [];
            snap.forEach(doc => {
                const d = doc.data();
                items.push({ 
                    title: d.title, url: d.url, badge: 'Pick', color: '#ff9800', author: null 
                });
            });
            renderNewsSlide(slideRec, "🏆 管理者おすすめ", "Qiitaトレンド ➡", items, 1);
        } catch(e) { slideRec.innerHTML = '<p>読み込みエラー</p>'; }
    }

    // B. Qiitaトレンド (プロキシAPI経由)
    if (slideTrend) {
        slideTrend.innerHTML = '<p>読み込み中...</p>';
        try {
            // キャッシュチェック (LocalStorage)
            const cacheKey = 'qiita_trends_cache';
            const cacheTimeKey = 'qiita_trends_timestamp';
            const cachedData = localStorage.getItem(cacheKey);
            const cachedTime = localStorage.getItem(cacheTimeKey);
            const now = new Date().getTime();

            if (cachedData && cachedTime && (now - parseInt(cachedTime) < 3600000)) { // 1時間キャッシュ
                let items = JSON.parse(cachedData);
                renderNewsSlide(slideTrend, "📈 Qiitaトレンド", "⬅ 管理者おすすめ", items, 0);
            } else {
                // API取得
                const targetUrl = 'https://qiita.com/api/v2/items?page=1&per_page=20&query=stocks:>20';
                const data = await fetchWithProxy(targetUrl);
                let items = [];
                if (data && Array.isArray(data)) {
                    items = data.map(item => ({
                        title: item.title, url: item.url, badge: 'Qiita', color: '#55c500', 
                        author: (item.user ? item.user.id : 'unknown')
                    }));
                    if (items.length > maxCount) items = items.slice(0, maxCount);
                    localStorage.setItem(cacheKey, JSON.stringify(items));
                    localStorage.setItem(cacheTimeKey, now.toString());
                    renderNewsSlide(slideTrend, "📈 Qiitaトレンド", "⬅ 管理者おすすめ", items, 0);
                } else {
                    slideTrend.innerHTML = '<p>記事を取得できませんでした</p>';
                }
            }
        } catch(e) { 
            console.error(e);
            slideTrend.innerHTML = '<p>読み込み失敗(API制限など)</p>'; 
        }
    }
}

function renderNewsSlide(container, title, navText, items, nextIndex) {
    container.innerHTML = '';
    
    // ヘッダー (ナビゲーション付き)
    const header = document.createElement('div');
    header.className = 'news-header';
    let leftNav = '', rightNav = '';
    if (nextIndex === 1) { 
         leftNav = `<span class="nav-hint" onclick="switchNewsSlide(1)">⬅ Qiita</span>`;
         rightNav = `<span class="nav-hint" onclick="switchNewsSlide(${nextIndex})">${navText}</span>`;
    } else { 
         leftNav = `<span class="nav-hint" onclick="switchNewsSlide(${nextIndex})">${navText}</span>`;
         rightNav = `<span class="nav-hint" onclick="switchNewsSlide(0)">Rec ➡</span>`;
    }
    header.innerHTML = `
        <div style="flex:1; text-align:left;">${leftNav}</div>
        <h3 style="flex:2; text-align:center; margin:0; font-size:1.1em;">${title}</h3>
        <div style="flex:1; text-align:right;">${rightNav}</div>
    `;
    container.appendChild(header);

    if (items.length === 0) { container.innerHTML += '<p>記事がありません</p>'; return; }

    const listId = `list-${Math.random().toString(36).substr(2, 9)}`;
    // ★設定: デフォルト表示数 (トグルを閉じている時の数)
    const defaultCount = (userSettings && userSettings.newsDefaultCount) ? parseInt(userSettings.newsDefaultCount) : 5;
    
    // 上部トグルボタン
    if (items.length > defaultCount) {
        const topToggle = document.createElement('button');
        topToggle.className = 'toggle-btn';
        topToggle.textContent = "🔽 もっと見る (全表示)";
        topToggle.onclick = () => toggleNewsItems(listId, topToggle, defaultCount);
        container.appendChild(topToggle);
    }

    const listDiv = document.createElement('div');
    listDiv.id = listId;
    
    items.forEach((item, index) => {
        const div = createNewsItem(item.title, item.url, item.badge, item.color, item.author);
        // デフォルト数を超えたら非表示クラスを付与
        if (index >= defaultCount) div.classList.add('hidden-item');
        listDiv.appendChild(div);
    });
    container.appendChild(listDiv);

    // 下部トグルボタン
    if (items.length > defaultCount) {
        const bottomToggle = document.createElement('button');
        bottomToggle.className = 'toggle-btn';
        bottomToggle.textContent = "🔽 もっと見る (全表示)";
        bottomToggle.onclick = () => toggleNewsItems(listId, bottomToggle, defaultCount); // 修正: ボタン自身を渡す
        container.appendChild(bottomToggle);
    }
}

function toggleNewsItems(listId, btn, count) {
    const list = document.getElementById(listId);
    // count番目の要素が隠れているかチェックして、現在の状態（開閉）を判定
    const isClosed = list.children[count] && list.children[count].classList.contains('hidden-item');

    if (isClosed) {
        // 開く処理: hidden-item を削除
        Array.from(list.children).forEach(child => child.classList.remove('hidden-item'));
        // ボタンのテキスト更新 (親コンテナ内の全トグルボタンを更新)
        updateToggleButtons(list.parentElement, "🔼 閉じる");
    } else {
        // 閉じる処理: count番目以降に hidden-item を付与
        Array.from(list.children).forEach((child, i) => { if (i >= count) child.classList.add('hidden-item'); });
        updateToggleButtons(list.parentElement, "🔽 もっと見る (全表示)");
    }
}

function updateToggleButtons(container, text) {
    const btns = container.querySelectorAll('.toggle-btn');
    btns.forEach(b => b.textContent = text);
}

function createNewsItem(title, url, badgeText, badgeColor, author = null) {
    const div = document.createElement('div');
    div.className = 'news-item';
    div.innerHTML = `
        <div style="background:${badgeColor}; color:white; font-size:10px; padding:2px 6px; border-radius:4px; margin-right:8px; height:fit-content; flex-shrink:0;">${badgeText}</div>
        <div style="flex:1; overflow:hidden;">
            <a href="${url}" target="_blank" style="text-decoration:none; color:#333; font-weight:bold; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${title}</a>
            ${author ? `<div style="font-size:0.8em; color:#888;">by @${author}</div>` : ''}
        </div>
    `;
    return div;
}

function switchNewsSlide(index) {
    const track = document.getElementById('newsTrack');
    if(!track) return;
    currentNewsSlide = index;
    track.style.transform = index === 0 ? 'translateX(0%)' : 'translateX(-50%)';
    
    const tab0 = document.getElementById('tab-news-0');
    const tab1 = document.getElementById('tab-news-1');
    if(tab0 && tab1) {
        if(index === 0) {
            tab0.style.background = '#007bff'; tab0.style.color = 'white';
            tab1.style.background = '#eee';    tab1.style.color = '#333';
        } else {
            tab0.style.background = '#eee';    tab0.style.color = '#333';
            tab1.style.background = '#007bff'; tab1.style.color = 'white';
        }
    }
}

function handleSwipe() {
    if (touchEndX < touchStartX - 50) { if (currentNewsSlide === 0) switchNewsSlide(1); }
    if (touchEndX > touchStartX + 50) { if (currentNewsSlide === 1) switchNewsSlide(0); }
}

async function fetchWithProxy(targetUrl) {
    const proxies = [
        (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
    ];
    for (const proxyFunc of proxies) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000); 
            const res = await fetch(proxyFunc(targetUrl), { signal: controller.signal });
            clearTimeout(timeoutId);
            if (res.ok) return await res.json();
        } catch (e) { console.log("Proxy fail:", e); }
    }
    return null;
}
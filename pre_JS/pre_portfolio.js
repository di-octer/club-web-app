// pre_portfolio.js

// --- ページ初期化 ---
window.addEventListener('load', () => {
    const bodyId = document.body.id;
    if (bodyId === 'page-portfolio') {
        initPortfolioList();
    } else if (bodyId === 'page-portfolio-detail') {
        initPortfolioDetail();
    }
});

// ==========================================
//   一覧ページ (page-portfolio)
// ==========================================
async function initPortfolioList() {
    const container = document.getElementById('portfolioList');
    if (!container) return;
    
    container.innerHTML = '<p style="text-align:center;">読み込み中...</p>';

    try {
        const snap = await db.collection('users').get();
        container.innerHTML = "";
        
        if (snap.empty) {
            container.innerHTML = '<p>ユーザーがいません</p>';
            return;
        }

        snap.forEach(doc => {
            const u = doc.data();
            // QiitaIDが登録されているユーザーのみ、など条件があればここでフィルタ
            // if (!u.qiitaId) return; 
            
            const card = createPortfolioCard(u, doc.id);
            container.appendChild(card);
        });

    } catch(e) {
        console.error(e);
        container.innerHTML = '<p style="color:red;">読み込みエラー</p>';
    }
}

function createPortfolioCard(user, uid) {
    const card = document.createElement('div');
    card.className = 'portfolio-card'; // CSSで定義
    
    const gitUrl = user.gitId ? `https://github.com/${user.gitId}` : '#';
    // Repoリンク: ユーザー設定に特定のRepoURLがあればそれを使う、なければユーザーページ
    const repoUrl = user.gitRepo || gitUrl; 

    card.innerHTML = `
        <div class="portfolio-info-row"><strong>${user.realName || user.displayName}</strong></div>
        <div class="portfolio-info-row"><span class="portfolio-label">Discord:</span> ${user.discordName || '-'}</div>
        <div class="portfolio-info-row"><span class="portfolio-label">GitHub:</span> ${user.gitId || '-'}</div>
        <div class="portfolio-info-row"><span class="portfolio-label">Repo:</span> <a href="${repoUrl}" target="_blank">${repoUrl}</a></div>
        <div class="portfolio-info-row"><span class="portfolio-label">Qiita:</span> ${user.qiitaId || '-'}</div>
        
        <div style="margin-top:15px; text-align:right;">
            <button class="btn-primary" onclick="location.href='pre_portfolio_detail.html?uid=${uid}'">記事を詳しく見る</button>
        </div>
    `;
    return card;
}

// ==========================================
//   詳細ページ (page-portfolio-detail)
// ==========================================
async function initPortfolioDetail() {
    const params = new URLSearchParams(window.location.search);
    const uid = params.get('uid');
    
    // ユーザーIDがない場合は一覧に戻す
    if (!uid) {
        alert("ユーザーが指定されていません");
        window.location.href = 'pre_portfolio.html';
        return;
    }

    const headerContainer = document.getElementById('userHeader');
    const articlesContainer = document.getElementById('articlesList');
    
    try {
        // 1. ユーザー情報取得
        const uDoc = await db.collection('users').doc(uid).get();
        // ドキュメントが存在しない場合でも空オブジェクトとして処理を続行させる
        const user = (uDoc.exists && uDoc.data()) ? uDoc.data() : {};

        // 各項目の安全な取得 (値がない場合は '-' や '未設定' を表示)
        const realName = user.realName || user.displayName || '名称未設定';
        const discordName = user.discordName || '-';
        const gitId = user.gitId || '-';
        const qiitaId = user.qiitaId || '-';
        
        // Git URL生成 (gitIdが無い場合はリンク無効化)
        const gitUrl = (user.gitId && user.gitId !== '-') ? `https://github.com/${user.gitId}` : '#';
        const repoUrlDisplay = (gitUrl !== '#') ? `<a href="${gitUrl}" target="_blank">${gitUrl}</a>` : '-';

        // ヘッダー描画 (要素が存在する場合のみ)
        if (headerContainer) {
            headerContainer.innerHTML = `
                <h2 style="margin-top:0;">${realName}</h2>
                <div class="portfolio-info-row"><strong>Discord:</strong> ${discordName}</div>
                <div class="portfolio-info-row"><strong>GitHub:</strong> ${gitId}</div>
                <div class="portfolio-info-row"><strong>Repo:</strong> ${repoUrlDisplay}</div>
                <div class="portfolio-info-row"><strong>Qiita:</strong> ${qiitaId}</div>
            `;
        }

        // 記事コンテナが無い場合はここで終了
        if (!articlesContainer) return;

        // Qiita IDがない場合
        if (!qiitaId || qiitaId === '-') {
            articlesContainer.innerHTML = "<p>Qiita IDが設定されていないため、記事を表示できません。</p>";
            return;
        }

        articlesContainer.innerHTML = '<p>記事を読み込んでいます...</p>';
        let articles = [];

        // =========================================================================
        // 【暫定対応】 フロントエンド版 (プロキシ経由 - 公開記事のみ)
        // =========================================================================
        try {
            const targetUrl = `https://qiita.com/api/v2/items?query=user:${qiitaId}&per_page=20`;
            const data = await fetchWithProxy(targetUrl); // pre_common.jsの関数
            
            if (Array.isArray(data)) {
                articles = data.map(item => ({
                    title: item.title,
                    url: item.url,
                    created_at: item.created_at,
                    body: item.rendered_body || item.body || ''
                }));
            } else {
                console.warn("Qiita API response invalid:", data);
                articles = [];
            }
        } catch(e) {
            console.error("Frontend Error:", e);
            articlesContainer.innerHTML = `<p style="color:red;">記事の取得に失敗しました (API制限または通信エラー)</p>`;
            return;
        }
        // =========================================================================

        if (!articles || articles.length === 0) {
            articlesContainer.innerHTML = "<p>公開記事が見つかりませんでした。</p>";
            return;
        }

        articlesContainer.innerHTML = "";
        articles.forEach(article => {
            const articleEl = createArticleToggle(article);
            articlesContainer.appendChild(articleEl);
        });

    } catch(e) {
        console.error(e);
        // エラー時も画面を真っ白にせずメッセージを表示
        if (document.body) {
            const msgDiv = document.createElement('div');
            msgDiv.style.padding = "20px";
            msgDiv.style.color = "red";
            msgDiv.innerHTML = `<p>予期せぬエラーが発生しました: ${e.message}</p><a href="pre_portfolio.html">一覧に戻る</a>`;
            document.body.prepend(msgDiv);
        }
    }
}

function createArticleToggle(article) {
    const wrapper = document.createElement('div');
    wrapper.className = 'article-wrapper'; // CSS用

    // ヘッダー (Sticky & Clickable)
    const header = document.createElement('div');
    header.className = 'article-header-sticky';
    header.innerHTML = `
        <span class="article-title">📄 ${article.title}</span>
        <div style="display:flex; align-items:center;">
            <a href="${article.url}" target="_blank" class="article-link-icon" title="Qiitaで開く" onclick="event.stopPropagation()">🔗</a>
            <span class="toggle-icon">▼</span>
        </div>
    `;

    // 本文コンテナ
    const body = document.createElement('div');
    body.className = 'article-body';
    body.innerHTML = `<div class="markdown-body">${article.body}</div>`; // QiitaのHTMLをそのまま挿入

    // クリックイベント
    header.onclick = () => {
        const isOpen = body.classList.contains('open');
        
        // 全ての開いている記事を閉じるならここで処理を追加
        // 今回は個別の開閉のみ実装
        
        if (isOpen) {
            body.classList.remove('open');
            header.querySelector('.toggle-icon').textContent = '▼';
        } else {
            body.classList.add('open');
            header.querySelector('.toggle-icon').textContent = '▲';
            
            // VSC風: タイトル位置へスクロール (Stickyヘッダー分を考慮)
            // 少し遅らせてDOM描画を待つとスムーズ
            setTimeout(() => {
                const headerHeight = 60; // Appbar
                const elementPosition = header.getBoundingClientRect().top;
                const offsetPosition = elementPosition + window.pageYOffset - headerHeight;
                
                window.scrollTo({
                    top: offsetPosition,
                    behavior: "smooth"
                });
            }, 10);
        }
    };

    wrapper.appendChild(header);
    wrapper.appendChild(body);
    return wrapper;
}
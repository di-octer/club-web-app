const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

// =====================================================
// ★設定: Qiita Team / Public の設定
// =====================================================
const QIITA_TEAM_ID = "ryukokuhorizon";
const QIITA_ACCESS_TOKEN = "acee93bd4c900518c7e4e3e5a4ab7d1fe708ff71";
const PUBLIC_SEARCH_QUERY = "stocks:>20"; // ニュースに表示する公開記事の条件
// =====================================================

// 共通ヘッダー
const HEADERS = {
    "Authorization": `Bearer ${QIITA_ACCESS_TOKEN}`,
    "Content-Type": "application/json"
};

// ヘルパー: Team APIへアクセス
async function fetchQiitaTeam(endpoint, params = "") {
    const url = `https://${QIITA_TEAM_ID}.qiita.com/api/v2${endpoint}${params ? '?' + params : ''}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return []; // エラー時は空配列を返す(処理を止めない)
    return await res.json();
}

// ヘルパー: Public APIへアクセス
async function fetchQiitaPublic(endpoint, params = "") {
    const url = `https://qiita.com/api/v2${endpoint}${params ? '?' + params : ''}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return [];
    return await res.json();
}

// -----------------------------------------------------
// 1. ホームニュース更新 (10分毎)
//    Admin Pick + Team記事 + Publicトレンド を統合
// -----------------------------------------------------
exports.updateHomeNews = functions.pubsub.schedule("every 10 minutes").onRun(async (context) => {
    try {
        const newsItems = [];

        // A. 管理者おすすめ (Firestore)
        const recSnap = await db.collection('recommended_news').orderBy('timestamp', 'desc').limit(10).get();
        recSnap.forEach(doc => {
            const d = doc.data();
            newsItems.push({
                type: 'admin',
                title: d.title, url: d.url,
                badge: 'Pick', badgeColor: '#ff9800',
                date: d.timestamp ? d.timestamp.toDate().toISOString() : new Date().toISOString(),
                priority: 3
            });
        });

        // B. FirestoreユーザーのQiita IDリスト作成 (Team記事のフィルタ用)
        const validQiitaIds = new Set();
        const userSnap = await db.collection('users').get();
        userSnap.forEach(doc => {
            const u = doc.data();
            if (u.qiitaId) validQiitaIds.add(u.qiitaId);
        });

        // C. Qiita Team記事 (メンバー限定)
        const teamData = await fetchQiitaTeam("/items", "page=1&per_page=30");
        if (Array.isArray(teamData)) {
            teamData.forEach(item => {
                // 登録ユーザーの記事のみ採用
                if (item.user && validQiitaIds.has(item.user.id)) {
                    newsItems.push({
                        type: 'qiita', // 表示上はQiitaとして扱う
                        title: item.title, url: item.url,
                        badge: 'Team', badgeColor: '#008080', // チーム記事は色を変える例
                        author: item.user.id,
                        date: item.created_at,
                        priority: 2
                    });
                }
            });
        }

        // D. Qiita Public記事 (トレンド/検索)
        const publicData = await fetchQiitaPublic("/items", `page=1&per_page=20&query=${encodeURIComponent(PUBLIC_SEARCH_QUERY)}`);
        if (Array.isArray(publicData)) {
            publicData.forEach(item => {
                newsItems.push({
                    type: 'qiita',
                    title: item.title, url: item.url,
                    badge: 'Qiita', badgeColor: '#55c500',
                    author: item.user ? item.user.id : 'unknown',
                    date: item.created_at,
                    priority: 1
                });
            });
        }

        // E. ソート (優先度 > 日付)
        newsItems.sort((a, b) => {
            if (a.priority !== b.priority) return b.priority - a.priority;
            return new Date(b.date) - new Date(a.date);
        });

        // F. 保存
        await db.collection('home_news').doc('feed').set({
            items: newsItems,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`News updated: ${newsItems.length} items`);
        return null;
    } catch (error) {
        console.error("News update failed:", error);
        return null;
    }
});

// -----------------------------------------------------
// 2. ポートフォリオ用記事取得 (アプリから呼び出し)
//    Team記事 + Public記事 を統合して返す
// -----------------------------------------------------
exports.getPortfolioArticles = functions.https.onCall(async (data, context) => {
    const targetQiitaId = data.qiitaId;
    if (!targetQiitaId) return { error: "No Qiita ID provided" };

    try {
        const query = encodeURIComponent(`user:${targetQiitaId}`);
        
        // 並行して取得
        const [teamItems, publicItems] = await Promise.all([
            fetchQiitaTeam("/items", `page=1&per_page=20&query=${query}`),
            fetchQiitaPublic("/items", `page=1&per_page=20&query=${query}`)
        ]);

        const merged = [];

        // チーム記事
        if (Array.isArray(teamItems)) {
            teamItems.forEach(item => {
                merged.push({
                    title: item.title,
                    url: item.url,
                    created_at: item.created_at,
                    body: item.rendered_body || item.body,
                    source: 'team'
                });
            });
        }

        // 公開記事 (重複チェック: URLで行う)
        if (Array.isArray(publicItems)) {
            publicItems.forEach(item => {
                // すでにチーム側で取得済みでなければ追加 (通常URLドメインが違うので重複しないはずだが念のため)
                if (!merged.some(m => m.url === item.url)) {
                    merged.push({
                        title: item.title,
                        url: item.url,
                        created_at: item.created_at,
                        body: item.rendered_body || item.body,
                        source: 'public'
                    });
                }
            });
        }

        // 新しい順にソート
        merged.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        return merged;

    } catch (e) {
        console.error("Portfolio fetch error:", e);
        return { error: "Failed to fetch articles" };
    }
});
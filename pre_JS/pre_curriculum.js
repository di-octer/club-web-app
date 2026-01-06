// pre_curriculum.js
// カリキュラムアプリ(iframe)との連携・SSO用スクリプト

document.addEventListener('DOMContentLoaded', () => {
    // ページロード時に初期化を試みる
    // ※Auth情報の読み込みを待つため、少し遅延させるかAuth監視が必要ですが、
    // pre_common.jsのonAuthStateChangedでページリロードがかかる作りならこれで動きます。
    checkAuthAndInitIframe();
});

function checkAuthAndInitIframe() {
    // Firebase Authの初期化待ち（簡易的なポーリング）
    const checkInterval = setInterval(async () => {
        if (typeof currentUser !== 'undefined' && currentUser) {
            clearInterval(checkInterval);
            await initCurriculumIframe();
        } else if (typeof isLoggingIn !== 'undefined' && !isLoggingIn && !currentUser) {
            // ログインしていない場合
            clearInterval(checkInterval);
            console.log("未ログインのためカリキュラム連携をスキップします");
        }
    }, 500);
}

async function initCurriculumIframe() {
    const iframe = document.getElementById('curriculumFrame');
    if (!iframe) return;

    console.log("Initialize Curriculum Iframe...");

    // 1. 送信するユーザーデータの構築
    // userSettings (Firestore) が未ロードの場合はcurrentUser (Auth) の情報でフォールバック
    const uid = currentUser.uid;
    const name = (typeof userSettings !== 'undefined' && userSettings.realName) 
                 ? userSettings.realName 
                 : (currentUser.displayName || "Unknown");
    
    const iconUrl = (typeof userSettings !== 'undefined' && userSettings.customIcon) 
                    ? userSettings.customIcon 
                    : currentUser.photoURL;

    // トークン取得 (バックエンド検証用)
    let token = "";
    try {
        token = await currentUser.getIdToken();
    } catch (e) {
        console.error("Token get error:", e);
    }

    const userDataPayload = {
        type: 'LOGIN_DATA_SYNC', // 開発者と合意した識別子
        user: {
            id: uid,
            name: name,
            iconUrl: iconUrl || "",
            isMember: userSettings.isMember || false,
            role: userSettings.role || "guest",
            studentId: userSettings.studentId || ""
        },
        authToken: token
    };

    // 2. iframeへの送信処理
    // iframeのロード完了を待ってから送る
    if (iframe.contentWindow) {
        // ターゲットURL (開発者と合意したURL。ここではGitHub Pagesを指定)
        // ※ローカル開発時は "http://localhost:xxxx" 等に変更が必要な場合があります
        const targetOrigin = "https://ryukoku-horizon.github.io"; 
        
        // iframeが既にロード済みの場合に対応するため、即時送信とonload送信の両方を行う
        iframe.contentWindow.postMessage(userDataPayload, targetOrigin);
        
        iframe.onload = () => {
            console.log("Sending Login Data to Iframe...");
            iframe.contentWindow.postMessage(userDataPayload, targetOrigin);
        };
    }
}
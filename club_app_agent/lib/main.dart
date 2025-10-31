// lib/main.dart (ディープリンク方式 修正版)

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_ble_peripheral/flutter_ble_peripheral.dart';
import 'package:nfc_manager/nfc_manager.dart';
import 'package:nfc_manager_felica/nfc_manager_felica.dart';
// ★追加★ ディープリンクリスナー
import 'package:app_links/app_links.dart';
// ★追加★ ブラウザ起動
import 'package:url_launcher/url_launcher.dart';

// --- グローバル変数 ---
final _blePeripheral = FlutterBlePeripheral();
// ★修正★ UIステータスを3つに変更
final ValueNotifier<String> _bleStatus = ValueNotifier('BLE初期化中...');
final ValueNotifier<String> _nfcStatus = ValueNotifier('NFC待機中...');
final ValueNotifier<String> _applinkStatus = ValueNotifier('ディープリンク待機中...');

// ★追加★ AppLinksのインスタンス
final _appLinks = AppLinks();
// StreamSubscription<Uri>? _linkSubscription;


void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // BLE発信を開始
  try {
    await startBleAdvertising();
  } catch (e) {
    _bleStatus.value = 'BLE起動失敗: $e';
  }

  // ★変更★ WebSocketサーバーの代わりにディープリンクリスナーを起動
  try {
    await initAppLinks();
    _applinkStatus.value = '✅ ディープリンク待機中';
  } catch (e) {
    _applinkStatus.value = '❌ ディープリンク初期化失敗: $e';
  }
  
  runApp(const ClubAppAgent());
}

// --- 1. BLE発信 (変更なし) ---
Future<void> startBleAdvertising() async {
  final advertiseData = AdvertiseData(
    serviceUuid: '0000180F-0000-1000-8000-00805F9B34FB', 
    includeDeviceName: false,
  );
  try {
    if (await _blePeripheral.isSupported) {
      await _blePeripheral.start(advertiseData: advertiseData);
      _bleStatus.value = '✅ BLE発信中 (Battery Service)';
      debugPrint('✅ BLE発信開始 (Battery Service: 0x180F)');
    } else {
      _bleStatus.value = '❌ BLE発信 (Peripheral) は非対応です';
      debugPrint('❌ BLE発信 (Peripheral) は非対応です');
    }
  } catch (e) {
    _bleStatus.value = '❌ BLE発信の開始に失敗';
    debugPrint('❌ BLE発信の開始に失敗: $e');
  }
}

// --- ★★★ 変更: WebSocketサーバー (削除) ★★★ ---
// Future<void> startWebSocketServer() async { ... } // <-- 削除
// --- ★★★ 修正: ディープリンクリスナー ★★★
Future<void> initAppLinks() async {
  // アプリがURL経由で起動されたことをリッスン
  
  // ( _linkSubscription への代入は削除済み)
  _appLinks.uriLinkStream.listen((uri) { // `uri` は Uri (non-null)
    
    _applinkStatus.value = 'ディープリンク受信: ${uri.toString()}';
    debugPrint('ディープリンク受信: ${uri.toString()}');
    
    // ★ 修正 ★
    // 警告 'The operand can't be 'null'' のため、'uri != null' のチェックを削除
    if (uri.scheme == 'club-agent' && uri.host == 'scan') {
      final returnUrl = uri.queryParameters['return_url'];
      if (returnUrl != null) {
        handleNfcScan(returnUrl);
      } else {
        _nfcStatus.value = '❌ リンクエラー: return_url がありません';
      }
    }
  });

  // ★★★ 修正: 
  // "initialLinkStringでエラーが出ています" とのご報告のため、
  // getInitialLink() / getInitialAppLink() / getInitialLinkUri() の
  // 処理を一旦すべて削除します。
  /*
  try {
    final initialLinkString = await _appLinks.getInitialLink(); 
    if (initialLinkString != null) {
       // ... (削除) ...
    }
  } catch (e) {
    debugPrint('getInitialLink 取得エラー: $e');
  }
  */

}

// --- ★★★ 追加: ブラウザに結果を返すヘルパー関数 ★★★ ---
Future<void> _returnToBrowser(String baseUrl, {String? cardId, String? error}) async {
  Map<String, String> queryParams = {};
  if (cardId != null) {
    queryParams['cardId'] = cardId;
  }
  if (error != null) {
    queryParams['nfcError'] = error;
  }

  // 元のURL (baseUrl) に、結果のパラメータ (?cardId=... or ?nfcError=...) を追加
  final Uri returnUri = Uri.parse(baseUrl).replace(
    queryParameters: queryParams,
  );

  debugPrint('ブラウザに戻ります: $returnUri');
  
  if (await canLaunchUrl(returnUri)) {
    // Safari (外部のブラウザ) でURLを開く
    await launchUrl(returnUri, mode: LaunchMode.externalApplication);
  } else {
    _nfcStatus.value = '❌ 復帰失敗: ブラウザを開けません';
  }
}


// --- 3. NFCスキャン (ディープリンク方式 修正版) ---
Future<void> handleNfcScan(String returnUrl) async {
  NfcAvailability availability = await NfcManager.instance.checkAvailability();
  
  if (availability != NfcAvailability.enabled) {
    _nfcStatus.value = '❌ NFCが利用できません';
    await _returnToBrowser(returnUrl, error: 'NFCが利用できません');
    return;
  }

  try {
    _nfcStatus.value = 'ICカードをスキャン中...';

    await NfcManager.instance.startSession(
      pollingOptions: {NfcPollingOption.iso18092},
      
      onDiscovered: (NfcTag tag) async {
        try {
          var felica = FeliCa.from(tag); 
          if (felica == null) {
            _nfcStatus.value = '❌ FeliCa規格のカードではありません';
            await NfcManager.instance.stopSession();
            await _returnToBrowser(returnUrl, error: 'FeliCa規格のカードではありません');
            return;
          }

          // ★ 修正 ★ 
          // '< .toUpperCase()' というタイプミスを修正
          String idm = felica.idm
              .map((e) => e.toRadixString(16).padLeft(2, '0'))
              .join('')
              .toUpperCase(); // <-- 正しくチェーンする
          
          _nfcStatus.value = '✅ 認証成功: $idm';
          await NfcManager.instance.stopSession();
          await _returnToBrowser(returnUrl, cardId: idm);

        } catch (e) {
           _nfcStatus.value = '❌ カード読取エラー: $e';
           await NfcManager.instance.stopSession();
           await _returnToBrowser(returnUrl, error: e.toString());
        }
      },
    );
  } catch (e) {
    _nfcStatus.value = '❌ NFCセッション開始エラー: $e';
    await _returnToBrowser(returnUrl, error: e.toString());
  }
}


// --- アプリのUI（画面）部分 (WebSocketステータスを削除) ---
class ClubAppAgent extends StatelessWidget {
  const ClubAppAgent({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false, 
      home: Scaffold(
        appBar: AppBar(
          title: const Text('部活動 認証エージェント'),
          backgroundColor: Colors.indigo,
          foregroundColor: Colors.white,
        ),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(20.0),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(Icons.radar, size: 80, color: Colors.indigo),
                const SizedBox(height: 20),
                const Text(
                  '認証エージェント 起動中',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 10),
                const Text(
                  '（Webアプリから認証するために、このアプリを起動したままにしてください）',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 14, color: Colors.grey),
                ),
                const SizedBox(height: 30),
                
                // --- ステータス表示 ---
                ValueListenableBuilder<String>(
                  valueListenable: _bleStatus,
                  builder: (context, status, child) {
                    return StatusCard(title: 'ビーコン (BLE)', status: status);
                  },
                ),
                const SizedBox(height: 10),
                // ★変更★ Web連携 (WebSocket) -> Web連携 (Deep Link)
                ValueListenableBuilder<String>(
                  valueListenable: _applinkStatus,
                  builder: (context, status, child) {
                    return StatusCard(title: 'Web連携 (Deep Link)', status: status);
                  },
                ),
                 const SizedBox(height: 10),
                ValueListenableBuilder<String>(
                  valueListenable: _nfcStatus,
                  builder: (context, status, child) {
                    return StatusCard(title: 'ICカード (NFC)', status: status);
                  },
                ),

              ],
            ),
          ),
        ),
      ),
    );
  }
}

// ステータス表示用のカスタムUIコンポーネント (変更なし)
class StatusCard extends StatelessWidget {
  final String title;
  final String status;
  const StatusCard({super.key, required this.title, required this.status});
  @override
  Widget build(BuildContext context) {
    final bool isError = status.startsWith('❌');
    final bool isSuccess = status.startsWith('✅');
    Color statusColor = Colors.grey;
    if (isError) statusColor = Colors.red;
    if (isSuccess) statusColor = Colors.green;
    return Card(
      elevation: 2.0,
      child: Padding(
        padding: const EdgeInsets.all(12.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
            const SizedBox(height: 5),
            Text(status, style: TextStyle(color: statusColor, fontSize: 14)),
          ],
        ),
      ),
    );
  }
}
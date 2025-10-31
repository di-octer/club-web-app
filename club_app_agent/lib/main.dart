// lib/main.dart (フェーズ3完了時点・全文)

import 'package:firebase_core/firebase_core.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_ble_peripheral/flutter_ble_peripheral.dart';
import 'package:nfc_manager/nfc_manager.dart';
import 'package:nfc_manager_felica/nfc_manager_felica.dart';
import 'package:app_links/app_links.dart';
import 'package:url_launcher/url_launcher.dart';

// --- グローバル変数 ---
final _blePeripheral = FlutterBlePeripheral();
final ValueNotifier<String> _bleStatus = ValueNotifier('BLE初期化中...');
final ValueNotifier<String> _nfcStatus = ValueNotifier('NFC待機中...');
final ValueNotifier<String> _applinkStatus = ValueNotifier('ディープリンク待機中...');
final _appLinks = AppLinks();
// ( _linkSubscription は警告削除済み)

// --- メイン関数 ---
void main() async {
  // Flutterの初期化
  WidgetsFlutterBinding.ensureInitialized();

  // Firebaseのネイティブ初期化
  await Firebase.initializeApp();

  // 既存のBLE発信
  try {
    await startBleAdvertising();
  } catch (e) {
    _bleStatus.value = 'BLE起動失敗: $e';
  }

  // 既存のディープリンクリスナー
  try {
    await initAppLinks();
    _applinkStatus.value = '✅ ディープリンク待機中';
  } catch (e) {
    _applinkStatus.value = '❌ ディープリンク初期化失敗: $e';
  }
  
  // ★ 修正: 新しいUI (AdminApp) を起動する
  runApp(const AdminApp());
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

// --- 2. ディープリンクリスナー (警告修正版) ---
Future<void> initAppLinks() async {
  _appLinks.uriLinkStream.listen((uri) { // `uri` は Uri (non-null)
    
    _applinkStatus.value = 'ディープリンク受信: ${uri.toString()}';
    debugPrint('ディープリンク受信: ${uri.toString()}');
    
    if (uri.scheme == 'club-agent' && uri.host == 'scan') {
      final returnUrl = uri.queryParameters['return_url'];
      if (returnUrl != null) {
        handleNfcScan(returnUrl);
      } else {
        _nfcStatus.value = '❌ リンクエラー: return_url がありません';
      }
    }
  });
  // (getInitialLink の処理は削除済み)
}

// --- 3. ブラウザ復帰 (変更なし) ---
Future<void> _returnToBrowser(String baseUrl, {String? cardId, String? error}) async {
  Map<String, String> queryParams = {};
  if (cardId != null) {
    queryParams['cardId'] = cardId;
  }
  if (error != null) {
    queryParams['nfcError'] = error;
  }
  final Uri returnUri = Uri.parse(baseUrl).replace(
    queryParameters: queryParams,
  );
  debugPrint('ブラウザに戻ります: $returnUri');
  if (await canLaunchUrl(returnUri)) {
    await launchUrl(returnUri, mode: LaunchMode.externalApplication);
  } else {
    _nfcStatus.value = '❌ 復帰失敗: ブラウザを開けません';
  }
}

// --- 4. NFCスキャン (変更なし・エラー修正版) ---
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
          String idm = felica.idm
              .map((e) => e.toRadixString(16).padLeft(2, '0'))
              .join('')
              .toUpperCase();
          
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

// --- ★★★ ここからがフェーズ3aで追加する新しいUIコード ★★★ ---

// --- 新しいメインUI (タブ切り替え) ---
class AdminApp extends StatelessWidget {
  const AdminApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '管理者アプリ',
      theme: ThemeData(
        primarySwatch: Colors.indigo,
        visualDensity: VisualDensity.adaptivePlatformDensity,
      ),
      debugShowCheckedModeBanner: false,
      home: const AdminHomePage(),
    );
  }
}

// タブ切り替えを管理するメインの親ウィジェット
class AdminHomePage extends StatefulWidget {
  const AdminHomePage({super.key});

  @override
  State<AdminHomePage> createState() => _AdminHomePageState();
}

class _AdminHomePageState extends State<AdminHomePage> {
  int _selectedIndex = 0; // 現在選択中のタブ

  // 各タブに対応する画面（ページ）
  static final List<Widget> _widgetOptions = <Widget>[
    const StatusScreen(),     // 0. 既存のステータス画面
    const GpsAdminScreen(),   // 1. GPS登録・一覧 (スタブ)
    const FaceAdminScreen(),  // 2. 顔登録・一覧 (スタブ)
  ];

  void _onItemTapped(int index) {
    setState(() {
      _selectedIndex = index;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('管理者用 統合アプリ'),
      ),
      body: Center(
        child: _widgetOptions.elementAt(_selectedIndex),
      ),
      // --- タブバー ---
      bottomNavigationBar: BottomNavigationBar(
        items: const <BottomNavigationBarItem>[
          BottomNavigationBarItem(
            icon: Icon(Icons.radar),
            label: 'ステータス',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.location_on),
            label: 'GPS管理',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.face),
            label: '顔登録管理',
          ),
        ],
        currentIndex: _selectedIndex,
        selectedItemColor: Colors.indigo[800],
        onTap: _onItemTapped,
      ),
    );
  }
}

// --- 既存のUI (ステータス表示) を新しいタブ画面として再配置 ---
class StatusScreen extends StatelessWidget {
  const StatusScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              '認証エージェント 起動中',
              style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 10),
            const Text(
              '（Webアプリ/ユーザーアプリからの認証リクエストを待機しています）',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 14, color: Colors.grey),
            ),
            const SizedBox(height: 30),
            
            ValueListenableBuilder<String>(
              valueListenable: _bleStatus,
              builder: (context, status, child) {
                return StatusCard(title: 'ビーコン (BLE)', status: status);
              },
            ),
            const SizedBox(height: 10),
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
    );
  }
}

// 既存のUI（StatusCard）(変更なし)
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

// --- フェーズ4以降で実装する「スタブ」（仮の画面）---
class GpsAdminScreen extends StatelessWidget {
  const GpsAdminScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Text('（ここにGPS登録・一覧画面を作成します）', style: TextStyle(color: Colors.grey)),
    );
  }
}

class FaceAdminScreen extends StatelessWidget {
  const FaceAdminScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Text('（ここに顔登録・一覧画面を作成します）', style: TextStyle(color: Colors.grey)),
    );
  }
}
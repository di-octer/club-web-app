// lib/main.dart (フェーズ3完了時点・全文)

import 'package:firebase_core/firebase_core.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_ble_peripheral/flutter_ble_peripheral.dart';
import 'package:nfc_manager/nfc_manager.dart';
import 'package:nfc_manager_felica/nfc_manager_felica.dart';
import 'package:app_links/app_links.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'models/gps_area.dart'; // (ステップ4-3で作成)
import 'package:geolocator/geolocator.dart'; // ★ GPS取得

// --- グローバル変数 ---
// --- ★ 追加: グローバル変数 ---
final db = FirebaseFirestore.instance;
// アプリ全体で共有するGPSエリアのリスト
final ValueNotifier<List<GpsArea>> globalGpsAreas = ValueNotifier([]);
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

  // ★ 追加: 起動時にGPSデータを読み込む
  await loadGpsAreasFromFirestore();

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

// --- ★ 追加: GPSデータ読み込み (Firebase版) ---
Future<void> loadGpsAreasFromFirestore() async {
  debugPrint("Firestore からGPSエリアデータを読み込み中...");
  try {
    final snapshot = await db.collection("gps_areas").get();

    if (snapshot.docs.isEmpty) {
      debugPrint("Firestore に登録済みのGPSエリアはありません。");
      globalGpsAreas.value = [];
      return;
    }

    // FirestoreのMapからGpsAreaオブジェクトのリストに変換
    final loadedGpsAreas = snapshot.docs.map((doc) {
      return GpsArea.fromJson(doc.data());
    }).toList();

    globalGpsAreas.value = loadedGpsAreas;
    debugPrint("Firestore から ${loadedGpsAreas.length} 件のGPSエリアを読み込みました。");

  } catch (e) {
    debugPrint("Firestore からのGPSエリア読み込みに失敗しました: $e");
    globalGpsAreas.value = [];
  }
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

// --- ★ GPS管理タブ (フェーズ4 実装版) ★ ---
class GpsAdminScreen extends StatefulWidget {
  const GpsAdminScreen({super.key});

  @override
  State<GpsAdminScreen> createState() => _GpsAdminScreenState();
}

class _GpsAdminScreenState extends State<GpsAdminScreen> {
  // ステートマシン (Web版と同じ)
  int _gpsScanStep = 0;
  GpsArea? _tempGpsArea;
  
  final _nameController = TextEditingController();
  String _statusMessage = 'エリア名を入力して登録を開始してください。';
  bool _isLoading = false;

  // --- データベースへの保存 ---
  Future<void> _saveGpsArea(GpsArea area) async {
    setState(() { _isLoading = true; _statusMessage = 'データベースに保存中...'; });
    try {
      // 1. データベースに保存
      // (db は main.dart で定義したグローバル変数)
      await db.collection("gps_areas").doc(area.name).set(area.toJson());
      
      // 2. グローバル変数 (UI) を更新
      final currentAreas = globalGpsAreas.value.toList();
      // 古いデータがあれば削除 (上書きのため)
      currentAreas.removeWhere((a) => a.name == area.name);
      currentAreas.add(area);
      globalGpsAreas.value = currentAreas; // ValueNotifier を更新

      _resetState('✅ 登録成功: 「${area.name}」を登録しました。');

    } catch (e) {
      _showErrorDialog('DB保存エラー', 'データベースへの保存に失敗しました: $e');
      _resetState('エラーが発生しました。', clearName: false);
    }
  }

  // --- データベースからの削除 ---
  Future<void> _deleteGpsArea(String areaName) async {
    if (await _showConfirmDialog('削除確認', '本当に「$areaName」を削除しますか？') == false) {
      return;
    }
    
    setState(() { _isLoading = true; _statusMessage = 'データベースから削除中...'; });
    try {
      // 1. データベースから削除
      await db.collection("gps_areas").doc(areaName).delete();
      
      // 2. グローバル変数 (UI) を更新
      final currentAreas = globalGpsAreas.value.toList();
      currentAreas.removeWhere((a) => a.name == areaName);
      globalGpsAreas.value = currentAreas; // ValueNotifier を更新
      
      _resetState('「$areaName」を削除しました。');

    } catch (e) {
      _showErrorDialog('DB削除エラー', 'データベースからの削除に失敗しました: $e');
      _resetState('エラーが発生しました。', clearName: false);
    }
  }

  // --- GPS座標の取得 ---
  Future<Position?> _getCurrentLocation() async {
    setState(() { _isLoading = true; });

    // 1. 権限チェック
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) {
        _showErrorDialog('権限エラー', '位置情報の利用が拒否されました。設定から許可してください。');
        _resetState('位置情報が利用できません。', clearName: false);
        return null;
      }
    }
    if (permission == LocationPermission.deniedForever) {
      _showErrorDialog('権限エラー', '位置情報の利用が恒久的に拒否されています。設定から変更してください。');
      _resetState('位置情報が利用できません。', clearName: false);
      return null;
    }

    // 2. 座標取得
    try {
      setState(() { _statusMessage = '座標を取得中...'; });
      // 高精度で取得
      return await Geolocator.getCurrentPosition(
          desiredAccuracy: LocationAccuracy.high);
    } catch (e) {
      _showErrorDialog('GPS取得エラー', '位置情報の取得に失敗しました: $e');
      _resetState('エラーが発生しました。', clearName: false);
      return null;
    }
  }

  // --- 登録ボタンのメインロジック ---
  Future<void> _onRegisterButtonPressed() async {
    final areaName = _nameController.text.trim();

    if (_gpsScanStep == 0) {
      // --- ステップ 0: 開始 ---
      if (areaName.isEmpty) {
        _showErrorDialog('入力エラー', 'エリア名を入力してください。');
        return;
      }
      // 重複チェック
      if (globalGpsAreas.value.any((a) => a.name == areaName)) {
        if (await _showConfirmDialog('上書き確認', '「$areaName」は既に登録されています。上書きしますか？') == false) {
          return;
        }
      }
      _tempGpsArea = GpsArea(name: areaName, lat1: 0, lon1: 0, lat2: 0, lon2: 0);
      setState(() {
        _gpsScanStep = 1;
        _statusMessage = 'エリアの「1つ目の端」に移動し、ボタンを押してください。';
        _isLoading = false;
      });
    } else if (_gpsScanStep == 1) {
      // --- ステップ 1: 1点目取得 ---
      final position = await _getCurrentLocation();
      if (position == null) return;
      
      _tempGpsArea = GpsArea(
        name: _tempGpsArea!.name,
        lat1: position.latitude,
        lon1: position.longitude,
        lat2: 0, lon2: 0,
      );
      setState(() {
        _gpsScanStep = 2;
        _statusMessage = '1点目 登録完了。エリアの「対角の端」に移動し、ボタンを押してください。';
        _isLoading = false;
      });
    } else if (_gpsScanStep == 2) {
      // --- ステップ 2: 2点目取得 & 保存 ---
      final position = await _getCurrentLocation();
      if (position == null) return;

      final finalArea = GpsArea(
        name: _tempGpsArea!.name,
        lat1: _tempGpsArea!.lat1,
        lon1: _tempGpsArea!.lon1,
        lat2: position.latitude,
        lon2: position.longitude,
      );
      
      // データベースに保存
      await _saveGpsArea(finalArea);
    }
  }

  // --- UI制御ヘルパー ---
  void _resetState(String message, {bool clearName = true}) {
    setState(() {
      _gpsScanStep = 0;
      _tempGpsArea = null;
      _isLoading = false;
      _statusMessage = message;
      if (clearName) {
        _nameController.clear();
      }
    });
  }

  Future<bool> _showConfirmDialog(String title, String content) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(content),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('キャンセル')),
          TextButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('OK')),
        ],
      ),
    );
    return result ?? false;
  }

  void _showErrorDialog(String title, String content) {
    showDialog(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(content),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('閉じる')),
        ],
      ),
    );
  }

  // --- ボタンのテキストを動的に変更 ---
  String _getButtonText() {
    switch (_gpsScanStep) {
      case 0: return '1. エリア定義を開始';
      case 1: return '2. 1つ目の端を登録';
      case 2: return '3. 2つ目の端を登録して完了';
      default: return '';
    }
  }
  
  @override
  Widget build(BuildContext context) {
    return ListView( // ColumnではなくListViewにしてスクロール可能にする
      padding: const EdgeInsets.all(16.0),
      children: [
        // --- 1. 登録セクション ---
        const Text('GPS認証エリア登録', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 10),
        TextField(
          controller: _nameController,
          decoration: const InputDecoration(
            labelText: 'エリア名',
            border: OutlineInputBorder(),
          ),
          // 登録中はエリア名を編集不可にする
          enabled: _gpsScanStep == 0, 
        ),
        const SizedBox(height: 10),
        ElevatedButton(
          onPressed: _isLoading ? null : _onRegisterButtonPressed,
          style: ElevatedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 16.0),
            backgroundColor: _gpsScanStep == 0 ? Colors.indigo : Colors.amber[700],
          ),
          child: _isLoading 
              ? const CircularProgressIndicator(color: Colors.white) 
              : Text(_getButtonText()),
        ),
        const SizedBox(height: 10),
        Text(_statusMessage, style: const TextStyle(fontWeight: FontWeight.bold), textAlign: TextAlign.center),

        const Divider(height: 40),

        // --- 2. 一覧セクション ---
        const Text('登録済みGPSエリア一覧', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 10),
        
        // グローバル変数の変更を監視してUIを自動更新
        ValueListenableBuilder<List<GpsArea>>(
          valueListenable: globalGpsAreas,
          builder: (context, areas, child) {
            if (_isLoading && areas.isEmpty) {
              // ロード中 (初回)
              return const Center(child: CircularProgressIndicator());
            }
            if (areas.isEmpty) {
              return const Center(child: Text('登録済みのエリアはありません。'));
            }
            
            // リストを逆順（新しいものが上）にして表示
            final reversedAreas = areas.reversed.toList();
            
            return ListView.builder(
              shrinkWrap: true, // ListView in ListView
              physics: const NeverScrollableScrollPhysics(), // 親ListViewでスクロール
              itemCount: reversedAreas.length,
              itemBuilder: (context, index) {
                final area = reversedAreas[index];
                return Card(
                  margin: const EdgeInsets.symmetric(vertical: 4.0),
                  child: ListTile(
                    title: Text(area.name),
                    subtitle: Text('Lat: ${area.lat1.toStringAsFixed(5)}, Lon: ${area.lon1.toStringAsFixed(5)}'),
                    trailing: IconButton(
                      icon: const Icon(Icons.delete, color: Colors.red),
                      onPressed: _isLoading ? null : () => _deleteGpsArea(area.name),
                    ),
                  ),
                );
              },
            );
          },
        ),
      ],
    );
  }
}

// FaceAdminScreen のスタブはそのまま残しておく
class FaceAdminScreen extends StatelessWidget {
  const FaceAdminScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Text('（ここに顔登録・一覧画面を作成します）', style: TextStyle(color: Colors.grey)),
    );
  }
}
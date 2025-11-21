// lib/main.dart (エラー修正済・全文)

import 'package:firebase_core/firebase_core.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart'; // ★ WriteBuffer のために追加
import 'package:flutter_ble_peripheral/flutter_ble_peripheral.dart';
import 'package:nfc_manager/nfc_manager.dart';
import 'package:nfc_manager_felica/nfc_manager_felica.dart';
import 'package:app_links/app_links.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'models/gps_area.dart'; 
import 'package:geolocator/geolocator.dart'; 
import 'models/face_object.dart';
import 'dart:convert'; // Base64変換用
import 'package:camera/camera.dart'; // カメラ
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart'; // 顔検出
import 'package:tflite_flutter/tflite_flutter.dart';
import 'package:image/image.dart' as img_lib; // 画像処理

// --- グローバル変数 ---
final db = FirebaseFirestore.instance;
final ValueNotifier<List<GpsArea>> globalGpsAreas = ValueNotifier([]);
final ValueNotifier<List<FaceObject>> globalFaces = ValueNotifier([]);
final _blePeripheral = FlutterBlePeripheral();
final ValueNotifier<String> _bleStatus = ValueNotifier('BLE初期化中...');
final ValueNotifier<String> _nfcStatus = ValueNotifier('NFC待機中...');
final ValueNotifier<String> _applinkStatus = ValueNotifier('ディープリンク待機中...');
final _appLinks = AppLinks();
late Interpreter _interpreter;
final ValueNotifier<String> _lastScannedCardInfo = ValueNotifier('スキャンされたICカード情報はありません');

// --- Base64デコード (script.js (v2) 互換) ---
Float32List _decodeBase64(String base64String) {
  final Uint8List uint8Array = base64Decode(base64String);
  return uint8Array.buffer.asFloat32List();
}

// --- 顔データ読み込み (Firebase版) ---
Future<void> loadFacesFromFirestore() async {
  debugPrint("Firestore から顔データを読み込み中...");
  try {
    final snapshot = await db.collection("faces").get();
    if (snapshot.docs.isEmpty) {
      debugPrint("Firestore に登録済みの顔はありません。");
      globalFaces.value = [];
      return;
    }
    final loadedFaces = snapshot.docs.map((doc) {
      final data = doc.data();
      final descriptors = (data['descriptors'] as List<dynamic>)
          .map((base64String) => _decodeBase64(base64String as String))
          .toList();
      return FaceObject(
        label: data['label'] as String,
        thumbnail: data['thumbnail'] as String, // Base64 Data URL
        descriptors: descriptors,
      );
    }).toList();
    globalFaces.value = loadedFaces;
    debugPrint("Firestore から ${loadedFaces.length} 件の顔データを読み込みました。");
  } catch (e) {
    debugPrint("Firestore からの顔データ読み込みに失敗しました: $e");
    globalFaces.value = [];
  }
}

// --- 顔データ「単体」削除 (Firebase版) ---
Future<void> deleteFaceFromFirestore(String faceLabel) async {
  debugPrint("Firestore から顔データ「$faceLabel」削除を開始...");
  try {
    await db.collection("faces").doc(faceLabel).delete();
    debugPrint("Firestore からの顔データ削除が成功しました。");
    final currentFaces = globalFaces.value.toList();
    currentFaces.removeWhere((f) => f.label == faceLabel);
    globalFaces.value = currentFaces;
  } catch (e) {
    debugPrint("Firestore からの削除に失敗 (顔): $e");
  }
}

// --- GPSデータ読み込み (Firebase版) ---
Future<void> loadGpsAreasFromFirestore() async {
  debugPrint("Firestore からGPSエリアデータを読み込み中...");
  try {
    final snapshot = await db.collection("gps_areas").get();
    if (snapshot.docs.isEmpty) {
      debugPrint("Firestore に登録済みのGPSエリアはありません。");
      globalGpsAreas.value = [];
      return;
    }
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

// --- メイン関数 ---
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();

  // ★★★ 修正: AIモデルをアプリ起動時に1回だけ初期化 ★★★
  try {
    _interpreter = await Interpreter.fromAsset('assets/mobilefacenet.tflite');
    debugPrint("FaceNet サービス初期化完了。");
  } catch (e) {
    debugPrint("--- 致命的エラー: FaceNet サービスの初期化に失敗しました ---");
    debugPrint(e.toString());
    runApp(MaterialApp(home: Scaffold(body: Center(child: Text("AIモデルのロードに失敗: $e")))));
    return;
  }
  // ★★★ 修正ここまで ★★★

  // 読み込みを並行して実行
  await Future.wait([
     loadGpsAreasFromFirestore(),
     loadFacesFromFirestore(),
  ]);

  try {
    await startBleAdvertising();
  } catch (e) {
    _bleStatus.value = 'BLE起動失敗: $e';
  }
  try {
    await initAppLinks();
    _applinkStatus.value = '✅ ディープリンク待機中';
  } catch (e) {
    _applinkStatus.value = '❌ ディープリンク初期化失敗: $e';
  }
  
  runApp(const AdminApp());
}

// --- 1. BLE発信 ---
Future<void> startBleAdvertising() async {
  final advertiseData = AdvertiseData(
    serviceUuid: '0000180F-0000-1000-8000-00805F9B34FB', 
    includeDeviceName: false,
  );
  try {
    if (await _blePeripheral.isSupported) {
      await _blePeripheral.start(advertiseData: advertiseData);
      _bleStatus.value = '✅ BLE発信中 (Battery Service)';
    } else {
      _bleStatus.value = '❌ BLE発信 (Peripheral) は非対応です';
    }
  } catch (e) {
    _bleStatus.value = '❌ BLE発信の開始に失敗';
  }
}

// --- 2. ディープリンクリスナー ---
Future<void> initAppLinks() async {
  _appLinks.uriLinkStream.listen((uri) { 
    _applinkStatus.value = 'ディープリンク受信: ${uri.toString()}';
    if (uri.scheme == 'club-agent' && uri.host == 'scan') {
      final returnUrl = uri.queryParameters['return_url'];
      if (returnUrl != null) {
        handleNfcScan(returnUrl);
      } else {
        _nfcStatus.value = '❌ リンクエラー: return_url がありません';
      }
    }
  });
}

// --- 3. ブラウザ復帰 ---
// main.dart の _returnToBrowser 関数を以下のように修正

Future<void> _returnToBrowser(String baseUrl, {String? cardId, String? error}) async {
  // ★★★ 修正箇所 ★★★
  // デバッグ用のスキームの場合はブラウザを開かない
  if (baseUrl.startsWith('debug://')) {
    _nfcStatus.value = '✅ デバッグスキャン完了';
    return;
  }
  // ★★★ 修正ここまで ★★★

  Map<String, String> queryParams = {};
  if (cardId != null) queryParams['cardId'] = cardId;
  if (error != null) queryParams['nfcError'] = error;
  final Uri returnUri = Uri.parse(baseUrl).replace(queryParameters: queryParams);
  if (await canLaunchUrl(returnUri)) {
    await launchUrl(returnUri, mode: LaunchMode.externalApplication);
  } else {
    _nfcStatus.value = '❌ 復帰失敗: ブラウザを開けません';
  }
}

// --- 4. NFCスキャン ---
Future<void> handleNfcScan(String returnUrl) async {
  NfcAvailability availability = await NfcManager.instance.checkAvailability();
  if (availability != NfcAvailability.enabled) {
    _nfcStatus.value = '❌ NFCが利用できません';
    // ★ 修正: デバッグ情報も更新
    _lastScannedCardInfo.value = '失敗 - 理由: NFCが利用できません';
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
            // ★ 修正: デバッグ情報も更新
            _lastScannedCardInfo.value = '失敗 - 理由: FeliCa規格のカードではありません';
            await NfcManager.instance.stopSession();
            await _returnToBrowser(returnUrl, error: 'FeliCa規格のカードではありません');
            return;
          }
          String idm = felica.idm.map((e) => e.toRadixString(16).padLeft(2, '0')).join('').toUpperCase();
          _nfcStatus.value = '✅ 認証成功: $idm';
          // ★ 修正: デバッグ情報も更新
          _lastScannedCardInfo.value = '成功 - IDm: $idm\n日時: ${DateTime.now()}';
          await NfcManager.instance.stopSession();
          await _returnToBrowser(returnUrl, cardId: idm);
        } catch (e) {
           _nfcStatus.value = '❌ カード読取エラー: $e';
           // ★ 修正: デバッグ情報も更新
           _lastScannedCardInfo.value = '失敗 - 理由: カード読取エラー\n詳細: $e';
           await NfcManager.instance.stopSession();
           await _returnToBrowser(returnUrl, error: e.toString());
        }
      },
    );
  } catch (e) {
    _nfcStatus.value = '❌ NFCセッション開始エラー: $e';
    // ★ 修正: デバッグ情報も更新
    _lastScannedCardInfo.value = '失敗 - 理由: NFCセッション開始エラー\n詳細: $e';
    await _returnToBrowser(returnUrl, error: e.toString());
  }
}

// --- 5. メインUI (タブ切り替え) ---
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

class AdminHomePage extends StatefulWidget {
  const AdminHomePage({super.key});
  @override
  State<AdminHomePage> createState() => _AdminHomePageState();
}

// main.dart の _AdminHomePageState クラスを以下のように修正

class _AdminHomePageState extends State<AdminHomePage> {
  int _selectedIndex = 0; 
  
  // ★★★ 修正箇所: ウィジェットのリストを変更 ★★★
  final List<Widget> _widgetOptions = <Widget>[
    const StatusScreen(),     
    const InfoAdminScreen(),   // GpsAdminScreen を InfoAdminScreen に変更
    const FaceRegisterScreen(),// FaceAdminScreen を FaceRegisterScreen に変更
  ];

  void _onItemTapped(int index) {
    setState(() { _selectedIndex = index; });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('管理者用 統合アプリ')),
      body: IndexedStack( // IndexedStack は維持
        index: _selectedIndex,
        children: _widgetOptions,
      ),
      bottomNavigationBar: BottomNavigationBar(
        // ★★★ 修正箇所: タブのラベルと順序を変更 ★★★
        items: const <BottomNavigationBarItem>[
          BottomNavigationBarItem(icon: Icon(Icons.radar), label: 'ステータス'),
          BottomNavigationBarItem(icon: Icon(Icons.list_alt), label: '登録情報管理'), // ラベルとアイコンを変更
          BottomNavigationBarItem(icon: Icon(Icons.face_retouching_natural), label: '顔登録'), // ラベルとアイコンを変更
        ],
        currentIndex: _selectedIndex,
        selectedItemColor: Colors.indigo[800],
        onTap: _onItemTapped,
      ),
    );
  }
}

// --- 6. ステータス画面 (タブ1) ---
class StatusScreen extends StatefulWidget {
  const StatusScreen({super.key});

  @override
  State<StatusScreen> createState() => _StatusScreenState();
}

class _StatusScreenState extends State<StatusScreen> {
  // ★★★ 修正: StreamからFutureに変更 ★★★
  // リアルタイムではなく、ボタンを押した時にデータを取得するためのFuture
  Future<QuerySnapshot>? _requestsFuture;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    // 画面が表示された時に一度だけデータを取得する
    _fetchRequests();
  }

  // ★★★ 修正: データ取得用のメソッドを新設 ★★★
  void _fetchRequests() {
    setState(() {
      _isLoading = true;
      _requestsFuture = db
          .collection('auth_requests')
          .where('status', isEqualTo: 'pending')
          .orderBy('requestTimestamp', descending: true)
          .get();
    });
    // 完了したらisLoadingをfalseにする
    _requestsFuture!.whenComplete(() {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    });
  }

  void _navigateToProcessingScreen(String requestId, String userName) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => AuthProcessingScreen(
          requestId: requestId,
          userName: userName,
        ),
      ),
    );
  }

  void _triggerDebugNfcScan() {
    handleNfcScan('debug://scan');
  }

  // main.dart の _StatusScreenState クラス内にある、
  // 既存の build メソッドを、以下のコードで完全に差し替えてください。

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // 認証リクエスト一覧
        Expanded(
          child: FutureBuilder<QuerySnapshot>(
            future: _requestsFuture,
            builder: (BuildContext context, AsyncSnapshot<QuerySnapshot> snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const Center(child: CircularProgressIndicator());
              }

              if (snapshot.hasError) {
                return Center(child: Text('エラーが発生しました: ${snapshot.error}'));
              }

              if (!snapshot.hasData || snapshot.data!.docs.isEmpty) {
                return Center(
                  child: Padding(
                    padding: const EdgeInsets.all(20.0),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.hourglass_empty, size: 60, color: Colors.grey),
                        const SizedBox(height: 16),
                        const Text('認証リクエストはありません', style: TextStyle(fontSize: 18, color: Colors.grey)),
                        const SizedBox(height: 8),
                        const Text('下の更新ボタンを押して、最新の情報を取得してください。', textAlign: TextAlign.center, style: TextStyle(color: Colors.grey)),
                      ],
                    ),
                  ),
                );
              }

              return ListView(
                padding: const EdgeInsets.all(8.0),
                children: snapshot.data!.docs.map((DocumentSnapshot document) {
                  Map<String, dynamic> data = document.data()! as Map<String, dynamic>;
                  final String userName = data['userName'] ?? '名前不明';
                  final Timestamp timestamp = data['requestTimestamp'] ?? Timestamp.now();
                  final String requestTime = '${timestamp.toDate().month}/${timestamp.toDate().day} ${timestamp.toDate().hour}:${timestamp.toDate().minute.toString().padLeft(2, '0')}';

                  return Card(
                    margin: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 4.0),
                    child: ListTile(
                      leading: const Icon(Icons.person_pin_circle, color: Colors.indigo, size: 40),
                      title: Text('$userName さんからの認証リクエスト', style: const TextStyle(fontWeight: FontWeight.bold)),
                      subtitle: Text('リクエスト日時: $requestTime'),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () {
                        _navigateToProcessingScreen(document.id, userName);
                      },
                    ),
                  );
                }).toList(),
              );
            },
          ),
        ),

        const Divider(height: 1, thickness: 1),

        // 手動更新ボタンとBLEステータス表示
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              // 1. リクエスト更新ボタン
              Expanded(
                flex: 2,
                child: ElevatedButton.icon(
                  icon: _isLoading 
                      ? const SizedBox(width: 18, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) 
                      : const Icon(Icons.refresh, size: 18),
                  label: const Text('Request更新'),
                  onPressed: _isLoading ? null : _fetchRequests,
                ),
              ),
              // 2. BLEステータス表示
              Expanded(
                flex: 3,
                child: ValueListenableBuilder<String>(
                  valueListenable: _bleStatus,
                  builder: (context, status, child) {
                    final isSuccess = status.startsWith('✅');
                    final isError = status.startsWith('❌');
                    return Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        Icon(
                          isSuccess ? Icons.bluetooth_searching : (isError ? Icons.bluetooth_disabled : Icons.bluetooth),
                          color: isSuccess ? Colors.blue : (isError ? Colors.red : Colors.grey),
                          size: 18,
                        ),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(
                            status,
                            style: TextStyle(
                              fontSize: 12,
                              color: isSuccess ? Colors.blue : (isError ? Colors.red : Colors.grey[700]),
                              fontWeight: FontWeight.bold,
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    );
                  },
                ),
              ),
            ],
          ),
        ),
        // デバッグ領域
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text('【デバッグ機能】', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
              const SizedBox(height: 4),
              ValueListenableBuilder<String>(
                valueListenable: _lastScannedCardInfo,
                builder: (context, info, child) {
                  final isSuccess = info.startsWith('成功');
                  return Card(
                    color: Colors.grey[200],
                    elevation: 0,
                    child: ListTile(
                      dense: true,
                      leading: Icon(
                        isSuccess ? Icons.check_circle : Icons.info_outline,
                        color: isSuccess ? Colors.green : Colors.grey[600],
                      ),
                      title: const Text('ICカードスキャン結果', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                      subtitle: Text(info, style: const TextStyle(fontSize: 12)),
                    ),
                  );
                },
              ),
              const SizedBox(height: 4),
              ElevatedButton.icon(
                icon: const Icon(Icons.nfc, size: 18),
                label: const Text('ICカードスキャン開始 (デバッグ用)'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.blueGrey,
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                onPressed: _triggerDebugNfcScan,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

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

// --- 9. 登録情報管理画面 (新タブ2) ---
class InfoAdminScreen extends StatefulWidget {
  const InfoAdminScreen({super.key});
  @override
  State<InfoAdminScreen> createState() => _InfoAdminScreenState();
}

class _InfoAdminScreenState extends State<InfoAdminScreen> {
  int _gpsScanStep = 0;
  GpsArea? _tempGpsArea;
  final _nameController = TextEditingController();
  String _statusMessage = 'エリア名を入力して登録を開始してください。';
  bool _isLoading = false;

  Future<void> _saveGpsArea(GpsArea area) async {
    setState(() { _isLoading = true; _statusMessage = 'データベースに保存中...'; });
    try {
      await db.collection("gps_areas").doc(area.name).set(area.toJson());
      final currentAreas = globalGpsAreas.value.toList();
      currentAreas.removeWhere((a) => a.name == area.name);
      currentAreas.add(area);
      globalGpsAreas.value = currentAreas; 
      _resetState('✅ 登録成功: 「${area.name}」を登録しました。');
    } catch (e) {
      _showErrorDialog('DB保存エラー', 'データベースへの保存に失敗しました: $e');
      _resetState('エラーが発生しました。', clearName: false);
    }
  }

  Future<void> _deleteGpsArea(String areaName) async {
    if (await _showConfirmDialog('削除確認', '本当に「$areaName」を削除しますか？') == false) return;
    setState(() { _isLoading = true; _statusMessage = 'データベースから削除中...'; });
    try {
      await db.collection("gps_areas").doc(areaName).delete();
      final currentAreas = globalGpsAreas.value.toList();
      currentAreas.removeWhere((a) => a.name == areaName);
      globalGpsAreas.value = currentAreas;
      // ★ 修正: 不要な括弧を削除
      _resetState('「$areaName」を削除しました。');
    } catch (e) {
      _showErrorDialog('DB削除エラー', 'データベースからの削除に失敗しました: $e');
      _resetState('エラーが発生しました。', clearName: false);
    }
  }

  Future<void> _deleteFace(String faceLabel) async {
    if (await _showConfirmDialog('削除確認', '本当に「$faceLabel」さんを削除しますか？') == false) return;
    setState(() { _isLoading = true; });
    await deleteFaceFromFirestore(faceLabel);
    setState(() { _isLoading = false; });
  }

  Future<Position?> _getCurrentLocation() async {
    setState(() { _isLoading = true; });
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
    try {
      setState(() { _statusMessage = '座標を取得中...'; });
      // ★ 修正: 'desiredAccuracy' -> 'locationSettings'
      const LocationSettings locationSettings = LocationSettings(
        accuracy: LocationAccuracy.high,
        distanceFilter: 0,
      );
      return await Geolocator.getCurrentPosition(locationSettings: locationSettings);
    } catch (e) {
      _showErrorDialog('GPS取得エラー', '位置情報の取得に失敗しました: $e');
      _resetState('エラーが発生しました。', clearName: false);
      return null;
    }
  }

  Future<void> _onRegisterButtonPressed() async {
    final areaName = _nameController.text.trim();
    if (_gpsScanStep == 0) {
      if (areaName.isEmpty) {
        _showErrorDialog('入力エラー', 'エリア名を入力してください。');
        return;
      }
      if (globalGpsAreas.value.any((a) => a.name == areaName)) {
        if (await _showConfirmDialog('上書き確認', '「$areaName」は既に登録されています。上書きしますか？') == false) return;
      }
      _tempGpsArea = GpsArea(name: areaName, lat1: 0, lon1: 0, lat2: 0, lon2: 0);
      setState(() {
        _gpsScanStep = 1;
        _statusMessage = 'エリアの「1つ目の端」に移動し、ボタンを押してください。';
        _isLoading = false;
      });
    } else if (_gpsScanStep == 1) {
      final position = await _getCurrentLocation();
      if (position == null) return;
      _tempGpsArea = GpsArea(
        name: _tempGpsArea!.name,
        lat1: position.latitude, lon1: position.longitude,
        lat2: 0, lon2: 0,
      );
      setState(() {
        _gpsScanStep = 2;
        _statusMessage = '1点目 登録完了。エリアの「対角の端」に移動し、ボタンを押してください。';
        _isLoading = false;
      });
    } else if (_gpsScanStep == 2) {
      final position = await _getCurrentLocation();
      if (position == null) return;
      final finalArea = GpsArea(
        name: _tempGpsArea!.name,
        lat1: _tempGpsArea!.lat1, lon1: _tempGpsArea!.lon1,
        lat2: position.latitude, lon2: position.longitude,
      );
      await _saveGpsArea(finalArea);
    }
  }

  void _resetState(String message, {bool clearName = true}) {
    setState(() {
      _gpsScanStep = 0;
      _tempGpsArea = null;
      _isLoading = false;
      _statusMessage = message;
      if (clearName) _nameController.clear();
    });
  }

  Future<bool> _showConfirmDialog(String title, String content) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title), content: Text(content),
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
        title: Text(title), content: Text(content),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('閉じる')),
        ],
      ),
    );
  }
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
    return ListView(
      padding: const EdgeInsets.all(16.0),
      children: [
        const Text('登録済み顔データ一覧', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 10),
        ValueListenableBuilder<List<FaceObject>>(
          valueListenable: globalFaces,
          builder: (context, faces, child) {
            if (faces.isEmpty) {
              return const Center(child: Text('登録済みの顔はありません。'));
            }
            final reversedFaces = faces.reversed.toList();
            return ListView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: reversedFaces.length,
              itemBuilder: (context, index) {
                final face = reversedFaces[index];
                return Card(
                  margin: const EdgeInsets.symmetric(vertical: 4.0),
                  child: ListTile(
                    leading: Image(
                      image: MemoryImage(base64Decode(face.thumbnail.split(',').last)),
                      width: 60, height: 80, fit: BoxFit.cover,
                    ),
                    title: Text(face.label),
                    trailing: IconButton(
                      icon: const Icon(Icons.delete, color: Colors.red),
                      onPressed: _isLoading ? null : () => _deleteFace(face.label),
                    ),
                  ),
                );
              },
            );
          },
        ),
        const Divider(height: 40),
        const Text('GPS認証エリア登録', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 10),
        TextField(
          controller: _nameController,
          decoration: const InputDecoration(labelText: 'エリア名', border: OutlineInputBorder()),
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
        const Text('登録済みGPSエリア一覧', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 10),
        ValueListenableBuilder<List<GpsArea>>(
          valueListenable: globalGpsAreas,
          builder: (context, areas, child) {
            if (_isLoading && areas.isEmpty) {
              return const Center(child: CircularProgressIndicator());
            }
            if (areas.isEmpty) {
              return const Center(child: Text('登録済みのエリアはありません。'));
            }
            final reversedAreas = areas.reversed.toList();
            return ListView.builder(
              shrinkWrap: true, 
              physics: const NeverScrollableScrollPhysics(),
              itemCount: reversedAreas.length,
              itemBuilder: (context, index) {
                final area = reversedAreas[index];
                return Card(
                  margin: const EdgeInsets.symmetric(vertical: 4.0),
                  child: ListTile(
                    title: Text(area.name),
                    subtitle: Text(
                      '端1: ${area.lat1.toStringAsFixed(6)}, ${area.lon1.toStringAsFixed(6)}\n端2: ${area.lat2.toStringAsFixed(6)}, ${area.lon2.toStringAsFixed(6)}',
                      style: const TextStyle(fontSize: 12.0),
                    ),
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

// --- 8. 顔登録画面 (新タブ3) ---
class FaceRegisterScreen extends StatefulWidget {
  const FaceRegisterScreen({super.key});
  @override
  State<FaceRegisterScreen> createState() => _FaceRegisterScreenState();
}

// main.dart の既存の「class _FaceAdminScreenState...」全体を、以下のコードで差し替えてください。

// main.dart の既存の「class _FaceAdminScreenState...」全体を、以下のコードで差し替えてください。

class _FaceRegisterScreenState extends State<FaceRegisterScreen> {
  // --- Stateを管理するオブジェクト (hot reload対応済) ---
  final TextEditingController _nameController = TextEditingController();
  final ValueNotifier<int> _scanStep = ValueNotifier(0);
  final ValueNotifier<String> _statusMessage = ValueNotifier('名前を入力して登録を開始してください。');
  final ValueNotifier<bool> _isLoading = ValueNotifier(false);
  final ValueNotifier<Face?> _detectedFace = ValueNotifier(null);
  final ValueNotifier<String> _detectedName = ValueNotifier("不明");
  final ValueNotifier<Color> _boxColor = ValueNotifier(Colors.red);

  final List<String> _scanInstructions = [
    "", "1/5: 正面を向いてください", "2/5: 顔を「左」に向けてください", "3/5: 顔を「右」に向けてください",
    "4/5: 顔を「上」に向けてください", "5/5: 顔を「下」に向けてください",
  ];

  // --- 内部状態変数 ---
  List<Float32List> _scanDescriptors = [];
  String _scanThumbnailBase64 = '';
  CameraController? _cameraController;
  FaceDetector? _faceDetector;
  bool _isDetecting = false;
  Size? _cameraImageSize;
  InputImageRotation? _cameraRotation;
  CameraImage? _lastCameraImage;
  bool _isFaceMatcherBuilt = false;

  @override
  void initState() {
    super.initState();
    globalFaces.addListener(_buildFaceMatcher);
    
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _initializeServices();
    });
  }

  @override
  void dispose() {
    _cameraController?.dispose();
    _faceDetector?.close();
    globalFaces.removeListener(_buildFaceMatcher);
    _nameController.dispose();
    _scanStep.dispose();
    _statusMessage.dispose();
    _isLoading.dispose();
    _detectedFace.dispose();
    _detectedName.dispose();
    _boxColor.dispose();
    super.dispose();
  }
  
  // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★
  // ★★★ これがロードクラッシュを修正する最重要メソッドです ★★★
  // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★
  // _FaceAdminScreenState クラス内の既存の _initializeServices メソッドを、
  // 以下のコードで完全に置き換えてください。

  Future<void> _initializeServices() async {
    try {
      // ローディングUIを表示するためにsetStateを一度だけ呼ぶ
      if (mounted) setState(() {});

      _statusMessage.value = 'カメラとAIモデルを初期化中...';
      _isLoading.value = true;
      
      _faceDetector = FaceDetector(
        options: FaceDetectorOptions(performanceMode: FaceDetectorMode.fast),
      );
      
      final cameras = await availableCameras();
      if (!mounted) return;

      final frontCamera = cameras.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front, orElse: () => cameras.first,
      );
      
      _cameraController = CameraController(
        frontCamera, ResolutionPreset.medium, enableAudio: false,
      );
      
      await _cameraController!.initialize();
      if (!mounted) return;

      _cameraImageSize = _cameraController!.value.previewSize;
      _cameraRotation = InputImageRotationValue.fromRawValue(frontCamera.sensorOrientation) ?? InputImageRotation.rotation270deg;
      _buildFaceMatcher(); 
      _cameraController!.startImageStream(_processImageStream);
      
      if (!mounted) return;
      _resetState('顔を検出中...');

      // ★★★ カメラ初期化完了をUIに通知する ★★★
      setState(() {});

    } catch (e) {
      if (!mounted) return;
      _resetState('カメラとAIの初期化に失敗しました。');
      _showErrorDialog("初期化エラー", "カメラまたはAIモデルの起動に失敗しました: $e");
      setState(() {}); // エラー時もUIを更新
    }
  }

  // --- これ以降のメソッドは変更ありません ---
  // (dialogs, buildFaceMatcher, findBestMatch, processImageStream, etc...)

  // [以前の回答で提示した、変更のないメソッド群をここに含めます]
  // _resetState, _showConfirmDialog, _showErrorDialog, _buildFaceMatcher, _findBestMatch...
  // _processImageStream, _onRegisterButtonPressed, encodeBase64, _saveFaceToFirestore, _getEmbedding...
  // そして build メソッド
  void _resetState(String message, {bool clearName = true}) {
    debugPrint("[STATE] _resetState: 開始 (message: '$message')");
    _scanStep.value = 0;
    _isLoading.value = false; // ★★★ ローディングを解除する重要な処理 ★★★
    debugPrint("[STATE]   -> _isLoading.value を false に設定しました");
    _statusMessage.value = message;
    if (clearName) _nameController.clear();
    _detectedName.value = "不明";
    _boxColor.value = Colors.red;
    debugPrint("[STATE] _resetState: 完了");
  }
  
  Future<bool> _showConfirmDialog(String title, String content) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title), content: Text(content),
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
        title: Text(title), content: Text(content),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('閉じる')),
        ],
      ),
    );
  }

  void _buildFaceMatcher() {
    _isFaceMatcherBuilt = globalFaces.value.isNotEmpty;
    debugPrint("FaceMatcher を再構築しました。登録済み: ${globalFaces.value.length} 件");
  }

  String _findBestMatch(Float32List queryDescriptor) {
    if (!_isFaceMatcherBuilt) return "不明";
    double minDistance = double.infinity;
    String bestMatchLabel = "不明";
    const double threshold = 1.0; 

    double euclideanDistance(Float32List d1, Float32List d2) {
      double sum = 0.0;
      for (int i = 0; i < d1.length; i++) {
        sum += (d1[i] - d2[i]) * (d1[i] - d2[i]);
      }
      return sum;
    }

    for (final face in globalFaces.value) {
      for (final descriptor in face.descriptors) {
        final double distance = euclideanDistance(descriptor, queryDescriptor);
        if (distance < minDistance && distance < threshold) {
          minDistance = distance;
          bestMatchLabel = face.label;
        }
      }
    }
    return bestMatchLabel;
  }

  // _FaceAdminScreenState クラス内の _processImageStream メソッドをこれで差し替え
  void _processImageStream(CameraImage cameraImage) async {
    if (_isDetecting || !mounted) return;
    _isDetecting = true;
    
    // このメソッドはUIスレッドで実行されるため、重い処理は避ける
    // ただし、UIの更新はこのメソッドが責任を持つ
    _lastCameraImage = cameraImage; 
    
    final inputImage = _inputImageFromCameraImage(cameraImage, _cameraRotation);
    if (inputImage == null) {
      _isDetecting = false;
      return;
    }
    
    try {
      final faces = await _faceDetector!.processImage(inputImage);
      if (!mounted) { _isDetecting = false; return; }

      Face? bestFace;
      if (faces.isNotEmpty) {
        bestFace = faces.reduce((a, b) => a.boundingBox.width > b.boundingBox.width ? a : b);
      }
      
      // 顔照合のための非同期処理（UIスレッドをブロックしない）
      String detectedName = "不明";
      Color boxColor = Colors.red;
      if (bestFace != null && _scanStep.value == 0 && _isFaceMatcherBuilt) {
        final img_lib.Image? croppedFaceImage = _cropFace(cameraImage, bestFace, _cameraRotation!);
        if (croppedFaceImage != null) {
          try {
            final Float32List descriptor = await _getEmbedding(croppedFaceImage);
            if (mounted) {
              final match = _findBestMatch(descriptor);
              detectedName = match;
              boxColor = (match == "不明") ? Colors.red : Colors.green;
            }
          } catch (e) { /* AIエラー時はデフォルト値のまま */ }
        }
      } else if (bestFace != null && _scanStep.value > 0) {
        detectedName = "";
        boxColor = Colors.green;
      }

      // ★★★ これがリアルタイム更新を復活させる修正です ★★★
      // 全ての計算が終わった後、最後に一度だけ setState を呼び出してUIを更新する
      if (mounted) {
        setState(() {
          _detectedFace.value = bestFace;
          _detectedName.value = detectedName;
          _boxColor.value = boxColor;
        });
      }
      // ★★★ 修正ここまで ★★★

    } catch (e) {
      debugPrint('顔検出/処理エラー: $e');
    } finally {
      _isDetecting = false;
    }
  }

  Future<void> _onRegisterButtonPressed() async {
    final newName = _nameController.text.trim();
    if (_scanStep.value == 0) {
      if (newName.isEmpty) { _showErrorDialog('入力エラー', '名前を入力してください。'); return; }
      if (globalFaces.value.any((f) => f.label == newName)) {
        if (await _showConfirmDialog('上書き確認', '「$newName」さんは既に登録されています。上書きしますか？') == false) return;
      }
      _scanDescriptors = [];
      _scanThumbnailBase64 = '';
      _scanStep.value = 1;
      _statusMessage.value = _scanInstructions[_scanStep.value];
      return;
    }
    
    final currentFace = _detectedFace.value;
    final currentCameraImage = _lastCameraImage;
    final currentRotation = _cameraRotation;
    final currentCameraController = _cameraController;

    if (currentFace == null || currentCameraImage == null || currentRotation == null || currentCameraController == null) {
      _showErrorDialog('スキャンエラー', '${_scanInstructions[_scanStep.value]} の顔を検出できません。\n(顔を枠内に収めてください)');
      return;
    }
    
    _isLoading.value = true;
    _statusMessage.value = 'スキャン中... (${_scanStep.value}/5)';

    try {
      if (_scanStep.value == 1) {
        await currentCameraController.stopImageStream();
        final XFile pictureFile = await currentCameraController.takePicture();
        if (!mounted) return; // 撮影後もチェック
        final Uint8List imageBytes = await pictureFile.readAsBytes();
        _scanThumbnailBase64 = 'data:image/jpeg;base64,${base64Encode(imageBytes)}';
        await currentCameraController.startImageStream(_processImageStream);
      }

      final img_lib.Image? aiImage = _cropFace(currentCameraImage, currentFace, currentRotation);
      if (aiImage == null) throw Exception("AI用顔画像の変換に失敗しました。");
      
      final Float32List descriptor = await _getEmbedding(aiImage);
      _scanDescriptors.add(descriptor);

      _scanStep.value++;
      if (_scanStep.value > 5) {
        await _saveFaceToFirestore(newName, _scanDescriptors, _scanThumbnailBase64);
      } else {
        _isLoading.value = false;
        _statusMessage.value = _scanInstructions[_scanStep.value];
      }
    } catch (e, stackTrace) {
      debugPrint("--- 処理エラーが発生しました ---");
      debugPrint("ERROR: $e");
      debugPrint("STACKTRACE: $stackTrace");
      if (!mounted) return;
      _showErrorDialog('処理エラー', '写真の撮影またはAI処理に失敗しました: $e');
      _resetState('エラーが発生しました。', clearName: false);
      if (currentCameraController.value.isStreamingImages == false) {
         await currentCameraController.startImageStream(_processImageStream);
      }
    }
  }
  
  String encodeBase64(Float32List floatList) {
    return base64Encode(floatList.buffer.asUint8List());
  }

  Future<void> _saveFaceToFirestore(String label, List<Float32List> descriptors, String thumbnailDataUrl) async {
    _statusMessage.value = 'データベースに保存中...';
    try {
      final dataToSave = {
        'label': label,
        'thumbnail': thumbnailDataUrl, 
        'descriptors': descriptors.map((d) => encodeBase64(d)).toList(),
      };
      await db.collection("faces").doc(label).set(dataToSave);
      if (!mounted) return;
      final newFace = FaceObject(
        label: label, 
        thumbnail: thumbnailDataUrl,
        descriptors: descriptors
      );
      final currentFaces = globalFaces.value.toList();
      currentFaces.removeWhere((f) => f.label == label); 
      currentFaces.add(newFace);
      globalFaces.value = currentFaces;
      
      _resetState('✅ 登録成功: 「$label」さんを登録しました。');
    } catch (e) {
      if (!mounted) return;
      _showErrorDialog('DB保存エラー', 'データベースへの保存に失敗しました: $e');
      _resetState('エラーが発生しました。', clearName: false);
    }
  }

  Future<Float32List> _getEmbedding(img_lib.Image croppedFaceImage) async {
    final imageBytes = croppedFaceImage.toUint8List();
    final Float32List inputBytes = Float32List(1 * 112 * 112 * 3);
    int pixelIndex = 0;
    for (int i = 0; i < imageBytes.length; i += 3) {
      final r = imageBytes[i];
      final g = imageBytes[i + 1];
      final b = imageBytes[i + 2];
      inputBytes[pixelIndex++] = (b / 127.5) - 1.0;
      inputBytes[pixelIndex++] = (g / 127.5) - 1.0;
      inputBytes[pixelIndex++] = (r / 127.5) - 1.0;
    }
    final input = inputBytes.reshape([1, 112, 112, 3]);
    final output = List.filled(1 * 192, 0.0).reshape([1, 192]);
    _interpreter.run(input, output);
    return Float32List.fromList(output[0]);
  }

  @override
  Widget build(BuildContext context) {
    if (_cameraController == null || !_cameraController!.value.isInitialized) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 10),
            ValueListenableBuilder<String>(
              valueListenable: _statusMessage,
              builder: (context, message, child) {
                return Text(message);
              },
            ),
          ],
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(16.0),
      children: [
        const Text('顔認証 (登録フェーズ)', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 10),
        ClipRect( // 念のため、ウィジェットがはみ出さないようにClipRectで囲みます
          child: AspectRatio(
            aspectRatio: 1 / _cameraController!.value.aspectRatio,
            child: Stack(
              fit: StackFit.expand,
              children: [
                CameraPreview(_cameraController!),
                if (_detectedFace.value != null && _cameraImageSize != null && _cameraRotation != null)
                  CustomPaint(
                    painter: FaceBoxPainter(
                      face: _detectedFace.value!,
                      imageSize: _cameraImageSize!,
                      rotation: _cameraRotation!,
                      name: _detectedName.value,
                      color: _boxColor.value,
                      isGrid: false,
                    ),
                  ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 10),
        ValueListenableBuilder<String>(
          valueListenable: _statusMessage,
          builder: (context, message, child) => 
            Text(message, style: const TextStyle(fontWeight: FontWeight.bold), textAlign: TextAlign.center),
        ),
        const SizedBox(height: 10),
        ValueListenableBuilder<int>(
          valueListenable: _scanStep,
          builder: (context, step, child) =>
            TextField(
              controller: _nameController,
              decoration: const InputDecoration(labelText: '登録名', border: OutlineInputBorder()),
              enabled: step == 0,
            ),
        ),
        const SizedBox(height: 10),
        ValueListenableBuilder<bool>(
          valueListenable: _isLoading,
          builder: (context, loading, child) {
            return ValueListenableBuilder<int>(
              valueListenable: _scanStep,
              builder: (context, step, child) {
                return ElevatedButton(
                  onPressed: loading ? null : _onRegisterButtonPressed,
                  style: ElevatedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 16.0),
                    backgroundColor: step == 0 ? Colors.indigo : Colors.amber[700],
                  ),
                  child: loading
                      ? const CircularProgressIndicator(color: Colors.white)
                      : Text(step == 0 ? '1. スキャン開始 (5段階)' : 'スキャン ($step/5)'),
                );
              },
            );
          },
        ),
      ],
    );
  }
}


// --- ★ 修正 ★ 9. ヘルパー関数群 (ファイルの末尾) ---

// main.dart の一番末尾
// ★ 修正 ★ FaceBoxPainter クラス (左右反転バグ 最終修正版)
class FaceBoxPainter extends CustomPainter {
  final Face face;
  final Size imageSize;
  final InputImageRotation rotation; // ★ 回転の向き
  final String name;
  final Color color;
  final bool isGrid; 

  FaceBoxPainter({
    required this.face, 
    required this.imageSize,
    required this.rotation,
    required this.name,
    required this.color,
    required this.isGrid, 
  });

  @override
  void paint(Canvas canvas, Size size) {
    // プレビュー(size) と 画像(imageSize) のスケール（比率）を計算
    // 回転(rotation)に応じて、画像の幅と高さを入れ替える
    final bool isRotated = rotation == InputImageRotation.rotation90deg || rotation == InputImageRotation.rotation270deg;
    
    final double scaleX = size.width / (isRotated ? imageSize.height : imageSize.width);
    final double scaleY = size.height / (isRotated ? imageSize.width : imageSize.height);

    // ★ 修正: 回転と反転を考慮した座標変換 (iOS/Android共通)
    Rect scaleRect(Face face) {
      switch (rotation) {
        // (省略: 90度は通常リアカメラ)
        case InputImageRotation.rotation90deg:
          return Rect.fromLTRB(
              face.boundingBox.left * scaleX,
              face.boundingBox.top * scaleY,
              face.boundingBox.right * scaleX,
              face.boundingBox.bottom * scaleY);
        
        // ★ これがフロントカメラ(270度) + ミラーリング(左右反転)の正しい補正
        case InputImageRotation.rotation270deg:
          return Rect.fromLTRB(
              (imageSize.height - face.boundingBox.bottom) * scaleX,
              face.boundingBox.left * scaleY,
              (imageSize.height - face.boundingBox.top) * scaleX,
              face.boundingBox.right * scaleY);
        
        default: // 0度または180度
          return Rect.fromLTRB(
              face.boundingBox.left * scaleX,
              face.boundingBox.top * scaleY,
              face.boundingBox.right * scaleX,
              face.boundingBox.bottom * scaleY);
      }
    }
    
    final Rect rect = scaleRect(face);
    final paint = Paint()
      ..color = color 
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3.0;

    canvas.drawRect(rect, paint);
    
    // 格子 (ご要望により 'isGrid' は常に false が渡される)
    if (isGrid) {
      paint.strokeWidth = 1.0;
      canvas.drawLine(
        Offset(rect.left + rect.width / 2, rect.top),
        Offset(rect.left + rect.width / 2, rect.bottom),
        paint
      );
      canvas.drawLine(
        Offset(rect.left, rect.top + rect.height / 2),
        Offset(rect.right, rect.top + rect.height / 2),
        paint
      );
    }
    
    if (name.isNotEmpty && name != "不明") {
      final textPainter = TextPainter(
        text: TextSpan(
          text: name,
          style: TextStyle(
            color: color, 
            fontSize: 18.0,
            backgroundColor: const Color.fromRGBO(0, 0, 0, 0.5), 
          ),
        ),
        textDirection: TextDirection.ltr,
      );
      textPainter.layout();
      textPainter.paint(canvas, Offset(rect.left, rect.top - textPainter.height - 4));
    }
  }

  @override
  bool shouldRepaint(covariant FaceBoxPainter oldDelegate) {
     return oldDelegate.face != face || 
            oldDelegate.name != name || 
            oldDelegate.color != color ||
            oldDelegate.isGrid != isGrid;
  }
}

// main.dart の一番末尾 (FaceBoxPainter の後)

// main.dart の一番末尾 (FaceBoxPainter の後)

// ★ 修正 ★ カメラ画像をMLKitのInputImageに変換するヘルパー
InputImage? _inputImageFromCameraImage(CameraImage image, InputImageRotation? rotation) {
  // ★ 修正: rotation が null なら処理中断
  if (rotation == null) return null;

  final WriteBuffer allBytes = WriteBuffer();
  for (final Plane plane in image.planes) {
    allBytes.putUint8List(plane.bytes);
  }
  final bytes = allBytes.done().buffer.asUint8List();
  final Size imageSize = Size(image.width.toDouble(), image.height.toDouble());
  
  final InputImageMetadata metadata = InputImageMetadata(
    size: imageSize,
    rotation: rotation, // ★ 修正: 'late' 変数から取得した回転を渡す
    format: InputImageFormatValue.fromRawValue(image.format.raw) ?? InputImageFormat.nv21,
    bytesPerRow: image.planes[0].bytesPerRow,
  );

  return InputImage.fromBytes(bytes: bytes, metadata: metadata);
}

// main.dart の一番末尾
// ★ 修正 ★ _cropFace 関数 (OBO バグ回避のため Float32 形式に変換)
img_lib.Image? _cropFace(CameraImage image, Face face, InputImageRotation rotation) {
  
  img_lib.Image? convertedImage;

  // 1. YUV から RGB への変換
  if (image.format.group == ImageFormatGroup.yuv420) {
    // 3チャンネル (RGB) の Uint8 形式で作成
    convertedImage = img_lib.Image(
        width: image.width, height: image.height, 
        format: img_lib.Format.uint8, numChannels: 3);
    
    final yPlane = image.planes[0].bytes;
    final yRowStride = image.planes[0].bytesPerRow;
    if (image.planes.length == 3) {
      final uPlane = image.planes[1].bytes;
      final vPlane = image.planes[2].bytes;
      final uvRowStride = image.planes[1].bytesPerRow;
      final vRowStride = image.planes[2].bytesPerRow;
      final uvPixelStride = image.planes[1].bytesPerPixel ?? 1;
      final vPixelStride = image.planes[2].bytesPerPixel ?? 1;
      for (int y = 0; y < image.height; y++) {
        for (int x = 0; x < image.width; x++) {
          final int yIndex = y * yRowStride + x;
          final int uvx = x ~/ 2;
          final int uvy = y ~/ 2;
          final int uIndex = uvy * uvRowStride + uvx * uvPixelStride;
          final int vIndex = uvy * vRowStride + uvx * vPixelStride;
          if (yIndex >= yPlane.length || uIndex >= uPlane.length || vIndex >= vPlane.length) continue;
          final int yValue = yPlane[yIndex];
          final int uValue = uPlane[uIndex];
          final int vValue = vPlane[vIndex];
          final int r = (yValue + 1.402 * (vValue - 128)).round().clamp(0, 255);
          final int g = (yValue - 0.344136 * (uValue - 128) - 0.714136 * (vValue - 128)).round().clamp(0, 255);
          final int b = (yValue + 1.772 * (uValue - 128)).round().clamp(0, 255); 
          convertedImage.setPixelRgb(x, y, r, g, b);
        }
      }
    } else if (image.planes.length == 2) {
      final uPlane = image.planes[1].bytes;
      final uvRowStride = image.planes[1].bytesPerRow;
      final uvPixelStride = image.planes[1].bytesPerPixel ?? 2;
      for (int y = 0; y < image.height; y++) {
        for (int x = 0; x < image.width; x++) {
          final int yIndex = y * yRowStride + x;
          final int uvIndex = (y ~/ 2) * uvRowStride + (x ~/ 2) * uvPixelStride;
          if (yIndex >= yPlane.length || uvIndex + 1 >= uPlane.length) continue;
          final int yValue = yPlane[yIndex];
          final int vValue = uPlane[uvIndex];
          final int uValue = uPlane[uvIndex + 1];
          final int r = (yValue + 1.402 * (vValue - 128)).round().clamp(0, 255);
          final int g = (yValue - 0.344136 * (uValue - 128) - 0.714136 * (vValue - 128)).round().clamp(0, 255);
          final int b = (yValue + 1.772 * (uValue - 128)).round().clamp(0, 255);
          convertedImage.setPixelRgb(x, y, r, g, b);
        }
      }
    }
  } 
   else if (image.format.group == ImageFormatGroup.bgra8888) {
    final plane = image.planes[0];
    final bgraImage = img_lib.Image.fromBytes(
        width: image.width, height: image.height, bytes: plane.bytes.buffer,
        rowStride: plane.bytesPerRow, order: img_lib.ChannelOrder.bgra);
    convertedImage = img_lib.Image(width: bgraImage.width, height: bgraImage.height);
    for (final pixel in bgraImage) {
      convertedImage.setPixelRgb(pixel.x, pixel.y, pixel.r, pixel.g, pixel.b);
    }
  } else { return null; }

  final x = face.boundingBox.left.toInt().clamp(0, convertedImage.width - 1);
  final y = face.boundingBox.top.toInt().clamp(0, convertedImage.height - 1);
  final w = face.boundingBox.width.toInt().clamp(0, convertedImage.width - x);
  final h = face.boundingBox.height.toInt().clamp(0, convertedImage.height - y);
  img_lib.Image croppedFace = img_lib.copyCrop(convertedImage, x: x, y: y, width: w, height: h);
  
  img_lib.Image rotatedImage;
  if (rotation == InputImageRotation.rotation270deg) {
    rotatedImage = img_lib.copyRotate(croppedFace, angle: -90);
  } else {
    rotatedImage = croppedFace;
  }
  
  return img_lib.copyResize(rotatedImage, width: 112, height: 112);
}

// --- 認証処理画面 (新規作成) ---
class AuthProcessingScreen extends StatefulWidget {
  final String requestId;
  final String userName;

  const AuthProcessingScreen({
    super.key,
    required this.requestId,
    required this.userName,
  });

  @override
  State<AuthProcessingScreen> createState() => _AuthProcessingScreenState();
}

class _AuthProcessingScreenState extends State<AuthProcessingScreen> {
  // 後のTODO: 将来的にカメラとNFCのロジックをここに実装する

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('${widget.userName} さんの認証'),
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(20.0),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                '「${widget.userName}」さんを認証します',
                style: const TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 30),
              
              // 後のTODO: ここにカメラプレビューを実装
              Container(
                height: 320,
                decoration: BoxDecoration(
                  color: Colors.black,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: const Center(
                  child: Icon(Icons.camera_alt, color: Colors.white, size: 60),
                ),
              ),
              const SizedBox(height: 20),

              // 後のTODO: ここにNFCスキャンステータスを実装
              const Card(
                child: ListTile(
                  leading: Icon(Icons.nfc),
                  title: Text('ICカードをスキャンしてください'),
                  subtitle: Text('ステータス: 待機中...'),
                ),
              ),
              const SizedBox(height: 30),
              
              // 後のTODO: 条件が満たされたら有効化する
              ElevatedButton.icon(
                icon: const Icon(Icons.check_circle),
                label: const Text('承認'),
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  backgroundColor: Colors.grey, // 初期状態は無効
                ),
                onPressed: null, // 初期状態は無効
              ),
            ],
          ),
        ),
      ),
    );
  }
}
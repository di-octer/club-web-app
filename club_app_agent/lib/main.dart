import 'package:firebase_core/firebase_core.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart'; 
import 'package:flutter_ble_peripheral/flutter_ble_peripheral.dart';
import 'package:nfc_manager/nfc_manager.dart';
import 'package:nfc_manager_felica/nfc_manager_felica.dart';
import 'package:app_links/app_links.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'models/gps_area.dart'; 
import 'package:geolocator/geolocator.dart'; 
import 'models/face_object.dart';
import 'dart:convert';
import 'package:camera/camera.dart';
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';
import 'package:tflite_flutter/tflite_flutter.dart';
import 'package:image/image.dart' as img_lib;

// --- グローバル変数 ---
final db = FirebaseFirestore.instance;
final ValueNotifier<List<GpsArea>> globalGpsAreas = ValueNotifier([]);
final ValueNotifier<List<FaceObject>> globalFaces = ValueNotifier([]);
final _blePeripheral = FlutterBlePeripheral();
final ValueNotifier<String> _bleStatus = ValueNotifier('BLE初期化中...');
final ValueNotifier<String> _nfcStatus = ValueNotifier('NFC待機中...');
final ValueNotifier<String> _applinkStatus = ValueNotifier('ディープリンク待機中...');
final ValueNotifier<String> _lastScannedCardInfo = ValueNotifier('スキャンされたICカード情報はありません');
final _appLinks = AppLinks();

// AIモデルは遅延初期化のためNull許容
Interpreter? _interpreter;

// --- Base64デコード ---
Float32List _decodeBase64(String base64String) {
  final Uint8List uint8Array = base64Decode(base64String);
  return uint8Array.buffer.asFloat32List();
}

// --- 顔データ読み込み ---
Future<void> loadFacesFromFirestore() async {
  try {
    final snapshot = await db.collection("faces").get();
    if (snapshot.docs.isEmpty) {
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
        thumbnail: data['thumbnail'] as String,
        descriptors: descriptors,
      );
    }).toList();
    globalFaces.value = loadedFaces;
  } catch (e) {
    debugPrint("顔データ読み込み失敗: $e");
    globalFaces.value = [];
  }
}

// --- 顔データ削除 ---
Future<void> deleteFaceFromFirestore(String faceLabel) async {
  try {
    await db.collection("faces").doc(faceLabel).delete();
    final currentFaces = globalFaces.value.toList();
    currentFaces.removeWhere((f) => f.label == faceLabel);
    globalFaces.value = currentFaces;
  } catch (e) {
    debugPrint("削除失敗 (顔): $e");
  }
}

// --- GPSデータ読み込み ---
Future<void> loadGpsAreasFromFirestore() async {
  try {
    final snapshot = await db.collection("gps_areas").get();
    if (snapshot.docs.isEmpty) {
      globalGpsAreas.value = [];
      return;
    }
    final loadedGpsAreas = snapshot.docs.map((doc) {
      return GpsArea.fromJson(doc.data());
    }).toList();
    globalGpsAreas.value = loadedGpsAreas;
  } catch (e) {
    debugPrint("GPSエリア読み込み失敗: $e");
    globalGpsAreas.value = [];
  }
}

// --- メイン関数 ---
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  
  try {
    await Firebase.initializeApp();
  } catch (e) {
    runApp(MaterialApp(home: Scaffold(body: Center(child: Text("Firebase初期化エラー: $e")))));
    return;
  }

  loadGpsAreasFromFirestore();
  loadFacesFromFirestore();

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

// --- BLE発信 ---
Future<void> startBleAdvertising() async {
  final advertiseData = AdvertiseData(
    serviceUuid: '0000180F-0000-1000-8000-00805F9B34FB', 
    includeDeviceName: false,
  );
  try {
    if (await _blePeripheral.isSupported) {
      await _blePeripheral.start(advertiseData: advertiseData);
      _bleStatus.value = '✅ BLE発信中';
    } else {
      _bleStatus.value = '❌ BLE非対応';
    }
  } catch (e) {
    _bleStatus.value = '❌ BLE発信失敗';
  }
}

// --- ディープリンク ---
Future<void> initAppLinks() async {
  _appLinks.uriLinkStream.listen((uri) { 
    _applinkStatus.value = '受信: ${uri.toString()}';
    if (uri.scheme == 'club-agent' && uri.host == 'scan') {
      final returnUrl = uri.queryParameters['return_url'];
      if (returnUrl != null) {
        handleNfcScan(returnUrl);
      }
    }
  });
}

// --- ブラウザ復帰 ---
Future<void> _returnToBrowser(String baseUrl, {String? cardId, String? error}) async {
  if (baseUrl.startsWith('debug://')) {
    _nfcStatus.value = '✅ デバッグスキャン完了';
    return;
  }
  Map<String, String> queryParams = {};
  if (cardId != null) queryParams['cardId'] = cardId;
  if (error != null) queryParams['nfcError'] = error;
  final Uri returnUri = Uri.parse(baseUrl).replace(queryParameters: queryParams);
  if (await canLaunchUrl(returnUri)) {
    await launchUrl(returnUri, mode: LaunchMode.externalApplication);
  } else {
    _nfcStatus.value = '❌ 復帰失敗';
  }
}

// --- NFCスキャン ---
Future<void> handleNfcScan(String returnUrl) async {
  NfcAvailability availability = await NfcManager.instance.checkAvailability();
  if (availability != NfcAvailability.enabled) {
    _nfcStatus.value = '❌ NFC利用不可';
    _lastScannedCardInfo.value = '失敗: NFCが無効です';
    await _returnToBrowser(returnUrl, error: 'NFCが無効');
    return;
  }
  try {
    _nfcStatus.value = 'ICカードスキャン中...';
    await NfcManager.instance.startSession(
      pollingOptions: {NfcPollingOption.iso18092},
      onDiscovered: (NfcTag tag) async {
        try {
          var felica = FeliCa.from(tag); 
          if (felica == null) {
            _nfcStatus.value = '❌ 非FeliCa';
            _lastScannedCardInfo.value = '失敗: FeliCaではありません';
            await NfcManager.instance.stopSession();
            await _returnToBrowser(returnUrl, error: 'Non-FeliCa');
            return;
          }
          String idm = felica.idm.map((e) => e.toRadixString(16).padLeft(2, '0')).join('').toUpperCase();
          _nfcStatus.value = '✅ 成功: $idm';
          _lastScannedCardInfo.value = '成功 - IDm: $idm\n日時: ${DateTime.now()}';
          await NfcManager.instance.stopSession();
          await _returnToBrowser(returnUrl, cardId: idm);
        } catch (e) {
           _nfcStatus.value = '❌ 読取エラー';
           _lastScannedCardInfo.value = '失敗: $e';
           await NfcManager.instance.stopSession();
           await _returnToBrowser(returnUrl, error: e.toString());
        }
      },
    );
  } catch (e) {
    _nfcStatus.value = '❌ セッションエラー';
    _lastScannedCardInfo.value = '失敗: $e';
    await _returnToBrowser(returnUrl, error: e.toString());
  }
}

// --- アプリ全体構成 ---
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

// --- AdminHomePage (修正: タブ切り替え時の制御を強化) ---
class AdminHomePage extends StatefulWidget {
  const AdminHomePage({super.key});
  @override
  State<AdminHomePage> createState() => _AdminHomePageState();
}

class _AdminHomePageState extends State<AdminHomePage> {
  int _selectedIndex = 0; 
  final GlobalKey<FaceRegisterScreenState> _faceRegisterKey = GlobalKey();
  late final List<Widget> _widgetOptions;

  @override
  void initState() {
    super.initState();
    _widgetOptions = <Widget>[
      const StatusScreen(),     
      const InfoAdminScreen(),   
      FaceRegisterScreen(key: _faceRegisterKey),
    ];
  }

  void _onItemTapped(int index) async {
    // 以前のタブが顔登録(index 2)だった場合、カメラを停止
    if (_selectedIndex == 2 && index != 2) {
      await _faceRegisterKey.currentState?.stopCamera();
    }
    
    setState(() { _selectedIndex = index; });

    // 新しいタブが顔登録(index 2)の場合、カメラを開始
    if (index == 2) {
      // 描画完了を待ってから確実に起動
      Future.delayed(const Duration(milliseconds: 200), () {
        _faceRegisterKey.currentState?.startCamera();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('管理者用 統合アプリ')),
      body: IndexedStack(
        index: _selectedIndex,
        children: _widgetOptions,
      ),
      bottomNavigationBar: BottomNavigationBar(
        items: const <BottomNavigationBarItem>[
          BottomNavigationBarItem(icon: Icon(Icons.radar), label: 'ステータス'),
          BottomNavigationBarItem(icon: Icon(Icons.list_alt), label: '登録情報管理'),
          BottomNavigationBarItem(icon: Icon(Icons.face_retouching_natural), label: '顔登録'),
        ],
        currentIndex: _selectedIndex,
        selectedItemColor: Colors.indigo[800],
        onTap: _onItemTapped,
      ),
    );
  }
}

// --- 1. ステータス画面 ---
class StatusScreen extends StatefulWidget {
  const StatusScreen({super.key});
  @override
  State<StatusScreen> createState() => _StatusScreenState();
}

class _StatusScreenState extends State<StatusScreen> {
  Future<QuerySnapshot>? _requestsFuture;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _fetchRequests();
  }

  void _fetchRequests() {
    setState(() {
      _isLoading = true;
      _requestsFuture = db
          .collection('auth_requests')
          .where('status', isEqualTo: 'pending')
          .orderBy('requestTimestamp', descending: true)
          .get();
    });
    _requestsFuture!.whenComplete(() {
      if (mounted) setState(() { _isLoading = false; });
    });
  }

  void _navigateToProcessingScreen(String requestId, String userName, String authType) {
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (context) => AuthProcessingScreen(
          requestId: requestId,
          userName: userName,
          authType: authType, // ★追加
        ),
      ),
    );
  }

  void _triggerDebugNfcScan() {
    handleNfcScan('debug://scan');
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Expanded(
          child: FutureBuilder<QuerySnapshot>(
            future: _requestsFuture,
            builder: (BuildContext context, AsyncSnapshot<QuerySnapshot> snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const Center(child: CircularProgressIndicator());
              }
              if (snapshot.hasError) {
                return Center(child: Text('エラー: ${snapshot.error}'));
              }
              if (!snapshot.hasData || snapshot.data!.docs.isEmpty) {
                return const Center(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(Icons.hourglass_empty, size: 60, color: Colors.grey),
                      SizedBox(height: 16),
                      Text('リクエストはありません', style: TextStyle(fontSize: 18, color: Colors.grey)),
                    ],
                  ),
                );
              }
              // _StatusScreenState の ListView 部分を修正
              return ListView(
                padding: const EdgeInsets.all(8.0),
                children: snapshot.data!.docs.map((DocumentSnapshot document) {
                  Map<String, dynamic> data = document.data()! as Map<String, dynamic>;
                  final String userName = data['userName'] ?? '名前不明';
                  // ★追加: 認証タイプを取得 (デフォルトは 'code')
                  final String authType = data['authType'] ?? 'code'; 
                  final Timestamp timestamp = data['requestTimestamp'] ?? Timestamp.now();
                  final String requestTime = '${timestamp.toDate().month}/${timestamp.toDate().day} ${timestamp.toDate().hour}:${timestamp.toDate().minute.toString().padLeft(2, '0')}';

                  // アイコンもタイプによって変える
                  IconData listIcon = Icons.help_outline;
                  if (authType == 'nfc') listIcon = Icons.nfc;
                  if (authType == 'code') listIcon = Icons.qr_code_scanner;

                  return Card(
                    margin: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 4.0),
                    child: ListTile(
                      leading: Icon(listIcon, color: Colors.indigo, size: 40),
                      title: Text('$userName さんからの認証リクエスト', style: const TextStyle(fontWeight: FontWeight.bold)),
                      subtitle: Text('タイプ: ${authType == 'nfc' ? 'NFC' : 'カラーコード'} / $requestTime'),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () {
                        // ★修正: 認証タイプを渡して遷移
                        _navigateToProcessingScreen(document.id, userName, authType);
                      },
                    ),
                  );
                }).toList(),
              );
            },
          ),
        ),
        const Divider(height: 1, thickness: 1),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: Row(
            children: [
              Expanded(
                flex: 2,
                child: ElevatedButton.icon(
                  icon: _isLoading 
                      ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) 
                      : const Icon(Icons.refresh, size: 18),
                  label: const Text('更新'),
                  onPressed: _isLoading ? null : _fetchRequests,
                ),
              ),
              const SizedBox(width: 12),
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
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              ValueListenableBuilder<String>(
                valueListenable: _lastScannedCardInfo,
                builder: (context, info, child) {
                  return Card(
                    color: Colors.grey[200], elevation: 0,
                    child: ListTile(
                      dense: true,
                      title: const Text('ICカードスキャン結果', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                      subtitle: Text(info, style: const TextStyle(fontSize: 12)),
                    ),
                  );
                },
              ),
              const SizedBox(height: 4),
              ElevatedButton.icon(
                icon: const Icon(Icons.nfc, size: 18),
                label: const Text('ICカードスキャン (デバッグ)'),
                style: ElevatedButton.styleFrom(backgroundColor: Colors.blueGrey, tapTargetSize: MaterialTapTargetSize.shrinkWrap),
                onPressed: _triggerDebugNfcScan,
              ),
            ],
          ),
        ),
      ],
    );
  }
}

// --- 2. 登録情報管理画面 (顔一覧 & GPS管理) ---
class InfoAdminScreen extends StatefulWidget {
  const InfoAdminScreen({super.key});
  @override
  State<InfoAdminScreen> createState() => _InfoAdminScreenState();
}

class _InfoAdminScreenState extends State<InfoAdminScreen> {
  final TextEditingController _nameController = TextEditingController();
  final TextEditingController _latController = TextEditingController();
  final TextEditingController _lonController = TextEditingController();
  bool _isLoading = false;

  @override
  void dispose() {
    _nameController.dispose();
    _latController.dispose();
    _lonController.dispose();
    super.dispose();
  }

  // --- 登録処理 (手入力のみ) ---
  Future<void> _registerArea() async {
    // キーボードを閉じる
    FocusScope.of(context).unfocus();

    final name = _nameController.text.trim();
    final latText = _latController.text.trim();
    final lonText = _lonController.text.trim();

    if (name.isEmpty || latText.isEmpty || lonText.isEmpty) {
      _showErrorDialog('入力エラー', 'エリア名、緯度、経度をすべて入力してください。');
      return;
    }

    final double? lat = double.tryParse(latText);
    final double? lon = double.tryParse(lonText);

    if (lat == null || lon == null) {
      _showErrorDialog('入力エラー', '座標は有効な数値で入力してください。\n(例: 35.6895)');
      return;
    }

    // 重複チェック
    if (globalGpsAreas.value.any((a) => a.name == name)) {
      if (await _showConfirmDialog('上書き確認', '「$name」は登録済みです。上書きしますか？') == false) return;
    }

    setState(() { _isLoading = true; });
    try {
      // 新しいデータモデル (中心点 + 活動フラグ)
      final area = GpsArea(name: name, lat: lat, lon: lon, isActive: false);
      
      await db.collection("gps_areas").doc(name).set(area.toJson());
      
      // ローカルリスト更新
      final currentAreas = globalGpsAreas.value.toList();
      currentAreas.removeWhere((a) => a.name == name);
      currentAreas.add(area);
      globalGpsAreas.value = currentAreas;

      // フォームクリア
      _nameController.clear();
      _latController.clear();
      _lonController.clear();
      
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('エリアを登録しました')));

    } catch (e) {
      _showErrorDialog('保存エラー', '$e');
    } finally {
      setState(() { _isLoading = false; });
    }
  }

  Future<void> _toggleActive(GpsArea area) async {
    final newStatus = !area.isActive;
    final action = newStatus ? "開始" : "終了";
    
    // ダイアログで確認
    if (await _showConfirmDialog('活動ステータス変更', '「${area.name}」の活動を $action しますか？') == false) return;

    setState(() { _isLoading = true; });
    try {
      await db.collection("gps_areas").doc(area.name).update({'isActive': newStatus});
      
      final currentAreas = globalGpsAreas.value.toList();
      final index = currentAreas.indexWhere((a) => a.name == area.name);
      if (index != -1) {
        currentAreas[index] = GpsArea(name: area.name, lat: area.lat, lon: area.lon, isActive: newStatus);
        globalGpsAreas.value = currentAreas;
      }
    } catch (e) {
      _showErrorDialog('更新エラー', '$e');
    } finally {
      setState(() { _isLoading = false; });
    }
  }

  Future<void> _deleteGpsArea(String areaName) async {
    if (await _showConfirmDialog('削除確認', '本当に「$areaName」を削除しますか？') == false) return;
    setState(() { _isLoading = true; });
    try {
      await db.collection("gps_areas").doc(areaName).delete();
      final currentAreas = globalGpsAreas.value.toList();
      currentAreas.removeWhere((a) => a.name == areaName);
      globalGpsAreas.value = currentAreas;
    } catch (e) {
      _showErrorDialog('削除エラー', '$e');
    } finally {
      setState(() { _isLoading = false; });
    }
  }

  Future<bool> _showConfirmDialog(String title, String content) async {
    return (await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: Text(title), content: Text(content),
      actions: [TextButton(onPressed: ()=>Navigator.pop(ctx,false), child: const Text('キャンセル')), TextButton(onPressed: ()=>Navigator.pop(ctx,true), child: const Text('OK'))]
    ))) ?? false;
  }
  void _showErrorDialog(String title, String content) {
    showDialog(context: context, builder: (ctx) => AlertDialog(title: Text(title), content: Text(content), actions: [TextButton(onPressed: ()=>Navigator.pop(ctx), child: const Text('閉じる'))]));
  }

  // --- 顔削除メソッド (変更なし) ---
  Future<void> _deleteFace(String faceLabel) async {
    if (await _showConfirmDialog('削除確認', '本当に「$faceLabel」さんを削除しますか？') == false) return;
    setState(() { _isLoading = true; });
    await deleteFaceFromFirestore(faceLabel);
    setState(() { _isLoading = false; });
  }
  
  ImageProvider _getSafeImageProvider(String thumbnailDataUrl) {
    try {
      final base64String = thumbnailDataUrl.split(',').last;
      if (base64String.isEmpty) throw Exception("Empty");
      return MemoryImage(base64Decode(base64String));
    } catch (e) {
      return const AssetImage('assets/placeholder.png');
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16.0),
      children: [
        // ★修正: GPS登録フォームを一番上に移動
        const Text('GPSエリア登録 (中心点)', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        const Text('※Googleマップ等で座標を確認して入力してください', style: TextStyle(fontSize: 12, color: Colors.grey)),
        const SizedBox(height: 10),
        TextField(controller: _nameController, decoration: const InputDecoration(labelText: 'エリア名', border: OutlineInputBorder())),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(child: TextField(controller: _latController, decoration: const InputDecoration(labelText: '緯度 (例: 35.xxxx)', border: OutlineInputBorder()), keyboardType: const TextInputType.numberWithOptions(decimal: true))),
            const SizedBox(width: 8),
            Expanded(child: TextField(controller: _lonController, decoration: const InputDecoration(labelText: '経度 (例: 139.xxxx)', border: OutlineInputBorder()), keyboardType: const TextInputType.numberWithOptions(decimal: true))),
          ],
        ),
        const SizedBox(height: 16),
        ElevatedButton(
          onPressed: _isLoading ? null : _registerArea,
          style: ElevatedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 16), backgroundColor: Colors.indigo),
          child: _isLoading ? const CircularProgressIndicator(color: Colors.white) : const Text('登録', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        ),
        const SizedBox(height: 20),

        // ★修正: GPS一覧を次に配置
        ValueListenableBuilder<List<GpsArea>>(
          valueListenable: globalGpsAreas,
          builder: (context, areas, child) {
            if (areas.isEmpty) return const Center(child: Text('登録なし'));
            return ListView.builder(
              shrinkWrap: true, physics: const NeverScrollableScrollPhysics(),
              itemCount: areas.length,
              itemBuilder: (context, index) {
                final area = areas[index];
                return Card(
                  color: area.isActive ? Colors.green[50] : null,
                  child: ListTile(
                    title: Text(area.name, style: const TextStyle(fontWeight: FontWeight.bold)),
                    subtitle: Text(
                      '${area.lat.toStringAsFixed(5)}, ${area.lon.toStringAsFixed(5)}\n状態: ${area.isActive ? "活動中" : "停止中"}',
                      style: TextStyle(color: area.isActive ? Colors.green : Colors.grey),
                    ),
                    trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Switch(
                          value: area.isActive,
                          onChanged: (val) => _toggleActive(area),
                          activeColor: Colors.green,
                        ),
                        IconButton(icon: const Icon(Icons.delete, color: Colors.red), onPressed: _isLoading ? null : () => _deleteGpsArea(area.name)),
                      ],
                    ),
                    onTap: () => _toggleActive(area),
                  ),
                );
              },
            );
          },
        ),

        const Divider(height: 40),

        // ★修正: 顔データ一覧を一番下に移動
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
                      image: _getSafeImageProvider(face.thumbnail),
                      width: 60, height: 80, fit: BoxFit.cover,
                      errorBuilder: (context, error, stackTrace) => 
                          Container(width: 60, height: 80, color: Colors.grey[300], child: const Icon(Icons.broken_image)),
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
      ],
    );
  }
}

// --- 3. 顔登録画面 (修正: ロード画面によるディレイ追加) ---
class FaceRegisterScreen extends StatefulWidget {
  const FaceRegisterScreen({super.key});
  @override
  State<FaceRegisterScreen> createState() => FaceRegisterScreenState();
}

class FaceRegisterScreenState extends State<FaceRegisterScreen> {
  final TextEditingController _nameController = TextEditingController();
  final ValueNotifier<int> _scanStep = ValueNotifier(0);
  final ValueNotifier<String> _statusMessage = ValueNotifier('名前を入力して開始');
  final ValueNotifier<bool> _isLoading = ValueNotifier(false);
  final ValueNotifier<Face?> _detectedFace = ValueNotifier(null);
  final ValueNotifier<String> _detectedName = ValueNotifier("不明");
  final ValueNotifier<Color> _boxColor = ValueNotifier(Colors.red);

  final List<String> _scanInstructions = [
    "", "1/5: 正面を向いてください", "2/5: 顔を「左」に向けてください", "3/5: 顔を「右」に向けてください",
    "4/5: 顔を「上」に向けてください", "5/5: 顔を「下」に向けてください",
  ];

  List<Float32List> _scanDescriptors = [];
  String _scanThumbnailBase64 = '';
  CameraController? _cameraController;
  FaceDetector? _faceDetector;
  bool _isDetecting = false;
  Size? _cameraImageSize;
  InputImageRotation? _cameraRotation;
  CameraImage? _lastCameraImage;
  bool _isFaceMatcherBuilt = false;
  
  bool _isCameraInitializing = false; 
  
  // ★追加: カメラ表示準備完了フラグ (赤い画面防止用)
  bool _isCameraReady = false; 

  @override
  void initState() {
    super.initState();
    void rebuild() => setState(() {});
    _detectedFace.addListener(rebuild);
    _detectedName.addListener(rebuild);
    _boxColor.addListener(rebuild);
    globalFaces.addListener(_buildFaceMatcher);
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

  void _resetState(String message, {bool clearName = true}) {
    _scanStep.value = 0;
    _isLoading.value = false;
    _statusMessage.value = message;
    if (clearName) {
      _nameController.clear();
    }
    _detectedName.value = "不明";
    _boxColor.value = Colors.red;
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
        actions: [TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('閉じる'))],
      ),
    );
  }

  void _buildFaceMatcher() {
    _isFaceMatcherBuilt = globalFaces.value.isNotEmpty;
  }

  // 外部から呼ばれる開始メソッド
  Future<void> startCamera() async {
    if (_isCameraInitializing || (_cameraController != null && _cameraController!.value.isInitialized)) {
      return;
    }
    await _initializeServices();
  }

  // 外部から呼ばれる停止メソッド
  Future<void> stopCamera() async {
    // ★修正: 停止時もフラグをリセットして画面を消す
    if (mounted) setState(() { _isCameraReady = false; });
    
    if (_cameraController != null) {
      await _cameraController!.stopImageStream();
      await _cameraController!.dispose();
      _cameraController = null;
      _isDetecting = false;
    }
  }

  Future<void> _initializeServices() async {
    if (_isCameraInitializing) return;
    _isCameraInitializing = true;
    
    // ★修正: 初期化開始時にフラグを落とす
    if (mounted) setState(() { _isCameraReady = false; });

    try {
      _isLoading.value = true;
      _statusMessage.value = 'カメラ起動中...';

      if (_interpreter == null) {
        try {
          _interpreter = await Interpreter.fromAsset('assets/mobilefacenet.tflite');
        } catch (e) {
          debugPrint("モデルロード失敗: $e");
        }
      }

      _faceDetector = FaceDetector(options: FaceDetectorOptions(performanceMode: FaceDetectorMode.fast));

      final cameras = await availableCameras();
      if (!mounted) return;
      
      final frontCamera = cameras.firstWhere(
          (c) => c.lensDirection == CameraLensDirection.front,
          orElse: () => cameras.first);

      if (_cameraController != null) {
        await _cameraController!.dispose();
      }

      _cameraController = CameraController(frontCamera, ResolutionPreset.medium, enableAudio: false);
      await _cameraController!.initialize();
      
      if (!mounted) return;

      _cameraImageSize = _cameraController!.value.previewSize;
      _cameraRotation = InputImageRotationValue.fromRawValue(frontCamera.sensorOrientation) ?? InputImageRotation.rotation270deg;
      _buildFaceMatcher();
      
      await _cameraController!.startImageStream(_processImageStream);

      // ★★★ 修正: 赤い画面を防ぐための意図的なディレイ ★★★
      if (mounted) {
        _statusMessage.value = 'カメラ準備中...';
      }
      await Future.delayed(const Duration(milliseconds: 50)); 

      if (mounted) {
        _resetState('名前を入力して開始');
        // ★修正: ここで初めて画面表示を許可
        setState(() { _isCameraReady = true; });
      }
    } catch (e) {
      if (mounted) {
        _resetState('初期化エラー');
        _showErrorDialog("エラー", "$e");
        setState(() {});
      }
    } finally {
      _isCameraInitializing = false;
    }
  }

  void _processImageStream(CameraImage cameraImage) async {
    if (_isDetecting || !mounted) return;
    _isDetecting = true;
    _lastCameraImage = cameraImage;

    final inputImage = _inputImageFromCameraImage(cameraImage, _cameraRotation);
    if (inputImage == null) {
      _isDetecting = false;
      return;
    }

    try {
      final faces = await _faceDetector!.processImage(inputImage);
      if (!mounted) {
        _isDetecting = false;
        return;
      }

      Face? bestFace;
      if (faces.isNotEmpty) {
        bestFace = faces.reduce((a, b) => a.boundingBox.width > b.boundingBox.width ? a : b);
      }

      String detectedName = "不明";
      Color boxColor = Colors.red;

      if (bestFace != null && _scanStep.value == 0 && _isFaceMatcherBuilt && _interpreter != null) {
        final img_lib.Image? croppedFaceImage = _cropFace(cameraImage, bestFace, _cameraRotation!);
        if (croppedFaceImage != null) {
          try {
            final Float32List descriptor = await _getEmbedding(croppedFaceImage);
            if (mounted) {
              final match = _findBestMatch(descriptor);
              detectedName = match;
              boxColor = (match == "不明") ? Colors.red : Colors.green;
            }
          } catch (e) {
            /* error */
          }
        }
      } else if (bestFace != null && _scanStep.value > 0) {
        detectedName = "";
        boxColor = Colors.green;
      }

      if (mounted) {
        setState(() {
          _detectedFace.value = bestFace;
          _detectedName.value = detectedName;
          _boxColor.value = boxColor;
        });
      }
    } catch (e) {
      debugPrint('Error: $e');
    } finally {
      _isDetecting = false;
    }
  }

  String _findBestMatch(Float32List queryDescriptor) {
    if (!_isFaceMatcherBuilt) return "不明";
    double minDistance = double.infinity;
    String bestMatchLabel = "不明";
    const double threshold = 1.0;
    for (final face in globalFaces.value) {
      for (final descriptor in face.descriptors) {
        double dist = 0.0;
        for (int i = 0; i < descriptor.length; i++) {
          dist += (descriptor[i] - queryDescriptor[i]) * (descriptor[i] - queryDescriptor[i]);
        }
        if (dist < minDistance && dist < threshold) {
          minDistance = dist;
          bestMatchLabel = face.label;
        }
      }
    }
    return bestMatchLabel;
  }

  Future<void> _onRegisterButtonPressed() async {
    final newName = _nameController.text.trim();
    if (_scanStep.value == 0) {
      if (newName.isEmpty) return;
      if (globalFaces.value.any((f) => f.label == newName)) {
        if (await _showConfirmDialog('確認', '上書きしますか？') == false) return;
      }
      _scanDescriptors = [];
      _scanThumbnailBase64 = '';
      _scanStep.value = 1;
      _statusMessage.value = _scanInstructions[_scanStep.value];
      setState(() {});
      return;
    }

    if (_detectedFace.value == null) return;

    _isLoading.value = true;
    setState(() {});
    try {
      if (_scanStep.value == 1) {
        await _cameraController!.stopImageStream();
        final XFile pictureFile = await _cameraController!.takePicture();
        if (!mounted) return;
        final Uint8List imageBytes = await pictureFile.readAsBytes();
        _scanThumbnailBase64 = 'data:image/jpeg;base64,${base64Encode(imageBytes)}';
        await _cameraController!.startImageStream(_processImageStream);
      }

      if (_interpreter != null) {
        final img_lib.Image? aiImage = _cropFace(_lastCameraImage!, _detectedFace.value!, _cameraRotation!);
        if (aiImage != null) {
          final Float32List descriptor = await _getEmbedding(aiImage);
          _scanDescriptors.add(descriptor);
        }
      }

      _scanStep.value++;
      if (_scanStep.value > 5) {
        await _saveFaceToFirestore(newName, _scanDescriptors, _scanThumbnailBase64);
        _scanStep.value = 0;
        _nameController.clear();
        _statusMessage.value = '登録完了';
      } else {
        _statusMessage.value = '${_scanInstructions[_scanStep.value]} (${_scanStep.value}/5)';
      }
    } catch (e) {
      _statusMessage.value = 'エラー: $e';
      if (_cameraController!.value.isStreamingImages == false) {
        await _cameraController!.startImageStream(_processImageStream);
      }
    } finally {
      _isLoading.value = false;
      setState(() {});
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
      final newFace = FaceObject(label: label, thumbnail: thumbnailDataUrl, descriptors: descriptors);
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
      inputBytes[pixelIndex++] = (imageBytes[i + 2] / 127.5) - 1.0;
      inputBytes[pixelIndex++] = (imageBytes[i + 1] / 127.5) - 1.0;
      inputBytes[pixelIndex++] = (imageBytes[i] / 127.5) - 1.0;
    }
    final input = inputBytes.reshape([1, 112, 112, 3]);
    final output = List.filled(1 * 192, 0.0).reshape([1, 192]);
    _interpreter!.run(input, output);
    return Float32List.fromList(output[0]);
  }

  @override
  Widget build(BuildContext context) {
    // ★修正: _isCameraReadyフラグをチェックし、準備ができるまではロード画面を表示
    if (!_isCameraReady || _cameraController == null || !_cameraController!.value.isInitialized) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 10),
            ValueListenableBuilder<String>(
              valueListenable: _statusMessage,
              builder: (context, message, child) => Text(message),
            ),
          ],
        ),
      );
    }

    return SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.all(16.0),
        child: Column(
          children: [
            const Text('顔認証 (登録フェーズ)', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            const SizedBox(height: 10),
            ClipRect(
              child: AspectRatio(
                aspectRatio: 1 / _cameraController!.value.aspectRatio,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    CameraPreview(_cameraController!),
                    ValueListenableBuilder<Face?>(
                      valueListenable: _detectedFace,
                      builder: (context, face, child) {
                        if (face == null || _cameraImageSize == null || _cameraRotation == null) {
                          return const SizedBox.shrink();
                        }
                        return CustomPaint(
                          painter: FaceBoxPainter(
                            face: face,
                            imageSize: _cameraImageSize!,
                            rotation: _cameraRotation!,
                            name: _detectedName.value,
                            color: _boxColor.value,
                            isGrid: false,
                          ),
                        );
                      },
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 10),
            ValueListenableBuilder<String>(
              valueListenable: _statusMessage,
              builder: (context, message, child) => Text(message, style: const TextStyle(fontWeight: FontWeight.bold), textAlign: TextAlign.center),
            ),
            const SizedBox(height: 10),
            ValueListenableBuilder<int>(
              valueListenable: _scanStep,
              builder: (context, step, child) => TextField(
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
        ),
      ),
    );
  }
}

// --- 認証処理画面 (顔認証[インカメ] -> コード認証[アウトカメ] シーケンシャル) ---
class AuthProcessingScreen extends StatefulWidget {
  final String requestId;
  final String userName;
  final String authType;

  const AuthProcessingScreen({
    super.key,
    required this.requestId,
    required this.userName,
    required this.authType,
  });

  @override
  State<AuthProcessingScreen> createState() => _AuthProcessingScreenState();
}

class _AuthProcessingScreenState extends State<AuthProcessingScreen> {
  CameraController? _cameraController;
  bool _isDetecting = false;
  
  int _authStep = 0; 
  String _statusMessage = "顔認証中... 本人を映してください";
  bool _isSwitchingCamera = false;
  bool _isFirstLoad = true;
  List<String> _targetColorCode = [];
  
  String _detectedName = "不明";
  Color _boxColor = Colors.red;
  Face? _detectedFace;
  Size? _cameraImageSize;
  InputImageRotation _currentRotation = InputImageRotation.rotation270deg;

  List<String> _detectedColors = ["?", "?", "?", "?"];
  
  @override
  void initState() {
    super.initState();
    _parseAuthType();
    if (widget.authType.startsWith('code')) {
      _initializeCamera(CameraLensDirection.front); // 最初はインカメ
    }
  }

  @override
  void dispose() {
    _stopCamera();
    super.dispose();
  }

  void _parseAuthType() {
    final parts = widget.authType.split(',');
    if (parts.length >= 5 && parts[0] == 'code') {
      _targetColorCode = parts.sublist(1, 5);
    } else {
      _targetColorCode = ["?", "?", "?", "?"]; 
    }
  }

  Future<void> _stopCamera() async {
    _isDetecting = false;
    if (_cameraController != null) {
      await _cameraController!.stopImageStream();
      await _cameraController!.dispose();
      _cameraController = null;
    }
  }

  Future<void> _initializeCamera(CameraLensDirection lensDirection) async {
    // 2回目以降（切り替え時）のみロード画面を表示
    if (!_isFirstLoad && mounted) {
      setState(() { _isSwitchingCamera = true; });
      await Future.delayed(const Duration(milliseconds: 700));
    }
    _isFirstLoad = false;

    await _stopCamera();

    try {
      final cameras = await availableCameras();
      final camera = cameras.firstWhere(
        (c) => c.lensDirection == lensDirection,
        orElse: () => cameras.first,
      );

      _currentRotation = InputImageRotationValue.fromRawValue(camera.sensorOrientation) 
          ?? (lensDirection == CameraLensDirection.front ? InputImageRotation.rotation270deg : InputImageRotation.rotation90deg);

      _cameraController = CameraController(
        camera,
        ResolutionPreset.medium,
        enableAudio: false,
        imageFormatGroup: ImageFormatGroup.yuv420,
      );

      await _cameraController!.initialize();
      if (!mounted) { await _stopCamera(); return; }
      
      _cameraImageSize = _cameraController!.value.previewSize;
      _cameraController!.startImageStream(_processCameraImage);
      
    } catch (e) {
      debugPrint("カメラ起動エラー: $e");
    } finally {
      if (mounted) setState(() { _isSwitchingCamera = false; });
    }
  }

  void _processCameraImage(CameraImage image) {
    if (_isDetecting || !mounted) return;
    _isDetecting = true;

    Future.microtask(() async {
      try {
        if (_authStep == 0) {
          await _processFaceAuth(image);
        } else if (_authStep == 1) {
          // コードスキャン時は全画面をRGB変換して処理
          final dummyFace = Face(
            boundingBox: Rect.fromLTWH(0, 0, image.width.toDouble(), image.height.toDouble()),
            landmarks: {}, contours: {}, trackingId: null,
          );
          
          final img_lib.Image? fullImage = _cropFace(image, dummyFace, InputImageRotation.rotation0deg);

          if (fullImage != null) {
            _processCodeScan(fullImage);
          }
        }
      } catch (e) {
        debugPrint("処理エラー: $e");
      } finally {
        if (mounted) _isDetecting = false;
      }
    });
  }

  Future<void> _processFaceAuth(CameraImage image) async {
    final inputImage = _inputImageFromCameraImage(image, _currentRotation); 
    if (inputImage == null) return;

    final faceDetector = FaceDetector(options: FaceDetectorOptions(performanceMode: FaceDetectorMode.fast));
    final faces = await faceDetector.processImage(inputImage);
    faceDetector.close();

    Face? bestFace;
    if (faces.isNotEmpty) {
      bestFace = faces.reduce((a, b) => a.boundingBox.width > b.boundingBox.width ? a : b);
    }

    String detectedName = "不明";
    Color boxColor = Colors.red;
    bool isMatch = false;

    if (bestFace != null && _interpreter != null) {
      final img_lib.Image? croppedFaceImage = _cropFace(image, bestFace, _currentRotation); 
      
      if (croppedFaceImage != null) {
        try {
          final Float32List descriptor = await _getEmbedding(croppedFaceImage);
          detectedName = _findBestMatchLocally(descriptor);
          
          if (detectedName == widget.userName) {
            boxColor = Colors.green;
            isMatch = true;
          } else {
            boxColor = Colors.red;
          }
        } catch (e) { /* error */ }
      }
    }

    if (mounted) {
      setState(() {
        _detectedFace = bestFace;
        _detectedName = detectedName;
        _boxColor = boxColor;
      });

      if (isMatch) {
        _authStep = 1; 
        _statusMessage = "顔認証OK! カメラを切り替えます...";
        _detectedFace = null;
        setState(() {});
        
        await _initializeCamera(CameraLensDirection.back);
        if (mounted) {
           setState(() {
             _statusMessage = "コードを枠に合わせてください";
           });
        }
      }
    }
  }

  Future<Float32List> _getEmbedding(img_lib.Image croppedFaceImage) async {
    final imageBytes = croppedFaceImage.toUint8List();
    final Float32List inputBytes = Float32List(1 * 112 * 112 * 3);
    int pixelIndex = 0;
    for (int i = 0; i < imageBytes.length; i += 3) {
      inputBytes[pixelIndex++] = (imageBytes[i+2] / 127.5) - 1.0; 
      inputBytes[pixelIndex++] = (imageBytes[i+1] / 127.5) - 1.0; 
      inputBytes[pixelIndex++] = (imageBytes[i] / 127.5) - 1.0;   
    }
    final input = inputBytes.reshape([1, 112, 112, 3]);
    final output = List.filled(1 * 192, 0.0).reshape([1, 192]);
    _interpreter!.run(input, output);
    return Float32List.fromList(output[0]);
  }

  String _findBestMatchLocally(Float32List queryDescriptor) {
    double minDistance = double.infinity;
    String bestMatchLabel = "不明";
    const double threshold = 1.0; 
    for (final face in globalFaces.value) {
      for (final descriptor in face.descriptors) {
        double dist = 0.0;
        for (int i = 0; i < descriptor.length; i++) dist += (descriptor[i] - queryDescriptor[i]) * (descriptor[i] - queryDescriptor[i]);
        if (dist < minDistance && dist < threshold) {
          minDistance = dist;
          bestMatchLabel = face.label;
        }
      }
    }
    return bestMatchLabel;
  }

  void _processCodeScan(img_lib.Image image) {
    final result = _scanColorCode(image);
    
    if (mounted) {
      setState(() {
        if (result != null) {
          _detectedColors = result;
          
          bool isMatch = true;
          for (int i = 0; i < 4; i++) {
            if (_targetColorCode.length <= i || result[i] != _targetColorCode[i]) {
              isMatch = false; 
              break;
            }
          }

          if (isMatch) {
            _statusMessage = "認証成功！ 承認ボタンを押してください";
            _authStep = 2; 
          } else {
            _statusMessage = "コード不一致: 認識中...";
          }
        }
      });
    }
  }

  List<String>? _scanColorCode(img_lib.Image image) {
    final int w = image.width;
    final int h = image.height;
    
    // ガイド枠と同じ比率 (前回修正分反映: boxW*0.52, boxH*0.8)
    final int boxW = (w * 0.52).toInt();
    final int boxH = ((h / 3) * 0.8).toInt();
    
    final int startX = (w - boxW) ~/ 2;
    final int startY = (h - boxH) ~/ 2;
    final int endY = startY + boxH;

    final int unitX = boxW ~/ 19;
    
    final int lineX_1 = startX + (unitX * 2.5).toInt(); // 左列
    final int lineX_4 = (startX + boxW) - (unitX * 2.5).toInt(); // 右列
    final int lineX_Center = w ~/ 2; // 中央列

    final color1 = _findColorBetweenX_Limited(image, lineX_1, startY, endY, _isRed, _isBlue) ?? "?";
    final color4 = _findColorBetweenX_Limited(image, lineX_4, startY, endY, _isRed, _isBlue) ?? "?";
    final area2 = _findColorBetweenX_Limited(image, lineX_Center, startY, endY, _isBlack, _isWhite) ?? "?";
    final area3 = _findColorBetweenX_Limited(image, lineX_Center, startY, endY, _isWhite, _isRed) ?? "?";

    if (color1 == "?" && area2 == "?" && area3 == "?" && color4 == "?") {
      return null; 
    }

    return [color1, area2, area3, color4];
  }

  String? _findColorBetweenX_Limited(
      img_lib.Image image, int x, int minY, int maxY,
      bool Function(int, int, int) isStart, bool Function(int, int, int) isEnd) {
    
    int startY = -1;
    int endY = -1;
    
    // 画像座標系: 画面上の縦方向(Y) = 画像上の横方向(X)としてスキャンするロジックの場合
    // しかし登録タブの _cropFace(rotation0deg) は画像をそのまま返すので、
    // スマホ縦持ち時のカメラ画像(横長)に対して、x, yはそのまま適用される。
    // つまり画面上の「縦」は画像上の「Y」座標。
    // _findColorBetweenX は「X軸を走査」する関数だったので、これでは横にスキャンしてしまう。
    // 縦（Y軸）を走査するように修正が必要。
    
    // ★修正: 縦方向(Y)に走査するループに変更
    final int targetColX = x; // 画面上のX座標

    for (int rowY = minY; rowY < maxY; rowY += 4) {
      if (targetColX >= image.width || rowY >= image.height) continue;

      final pixel = image.getPixel(targetColX, rowY);
      final r = pixel.r.toInt();
      final g = pixel.g.toInt();
      final b = pixel.b.toInt();

      if (startY == -1) {
        if (isStart(r, g, b)) startY = rowY;
      } else {
        if (isEnd(r, g, b)) {
          endY = rowY;
          break;
        }
      }
    }

    if (startY != -1 && endY != -1 && (endY - startY) > 10) {
      final int targetRowY = (startY + endY) ~/ 2;
      final p = _getAverageColor(image, targetColX, targetRowY);
      return _classifyColor(p[0], p[1], p[2]);
    }
    return null;
  }

  List<int> _getAverageColor(img_lib.Image image, int centerX, int centerY) {
    int rSum = 0, gSum = 0, bSum = 0, count = 0;
    const int range = 5; 

    for (int y = centerY - range; y <= centerY + range; y++) {
      for (int x = centerX - range; x <= centerX + range; x++) {
        if (x < 0 || x >= image.width || y < 0 || y >= image.height) continue;
        final pixel = image.getPixel(x, y);
        rSum += pixel.r.toInt();
        gSum += pixel.g.toInt();
        bSum += pixel.b.toInt();
        count++;
      }
    }

    if (count == 0) return [0, 0, 0];
    return [rSum ~/ count, gSum ~/ count, bSum ~/ count];
  }

  bool _isRed(int r, int g, int b) => r > 150 && g < 100 && b < 100;
  bool _isBlue(int r, int g, int b) => b > 150 && r < 100 && g < 100;
  bool _isBlack(int r, int g, int b) => r < 80 && g < 80 && b < 80;
  bool _isWhite(int r, int g, int b) => r > 180 && g > 180 && b > 180;

  String _classifyColor(int r, int g, int b) {
    if (r < 50 && g < 50 && b < 50) return "?";
    if (g > r + 30 && g > b + 30) return "G";
    if (r > 150 && g > 150 && b < 100) return "Y";
    if (g > 150 && b > 150 && r < 100) return "C";
    if (r > 150 && b > 150 && g < 100) return "M";
    return "?"; 
  }

  @override
  Widget build(BuildContext context) {
    // カメラ切り替え中
    if (_isSwitchingCamera) {
      return Scaffold(
        appBar: AppBar(title: Text(widget.userName)),
        body: Container(
          color: Colors.black,
          child: const Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                CircularProgressIndicator(color: Colors.white),
                SizedBox(height: 20),
                Text("顔認証成功！ カメラを切り替えています...", style: TextStyle(color: Colors.white, fontSize: 18)),
              ],
            ),
          ),
        ),
      );
    }

    // NFCモード
    if (widget.authType == 'nfc') {
      return Scaffold(
        appBar: AppBar(title: Text('${widget.userName} さんの認証 (NFC)')),
        body: const Center(child: Text("NFCスキャン機能は現在調整中です")),
      );
    }

    // カメラ初期化中
    if (_cameraController == null || !_cameraController!.value.isInitialized) {
      return Scaffold(appBar: AppBar(title: Text(widget.userName)), body: const Center(child: CircularProgressIndicator()));
    }

    return Scaffold(
      appBar: AppBar(title: Text(widget.userName)),
      body: Column(
        children: [
          Expanded(
            child: Stack(
              fit: StackFit.expand,
              children: [
                // アスペクト比調整 (回転に合わせて比率を切り替え)
                ClipRect(
                  child: AspectRatio(
                    aspectRatio: 1 / _cameraController!.value.aspectRatio,
                    child: CameraPreview(_cameraController!),
                  ),
                ),
                
                CustomPaint(
                  painter: GuideOverlayPainter(
                    isFaceStep: _authStep == 0,
                    face: _detectedFace,
                    imageSize: _cameraImageSize,
                    rotation: _currentRotation,
                  ),
                ),
                
                if (_authStep == 0 && _detectedFace != null)
                  Positioned(
                    bottom: 20, left: 0, right: 0,
                    child: Column(
                      children: [
                        Text("認識結果: $_detectedName", style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold, color: _boxColor, backgroundColor: Colors.black54)),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          Container(
            padding: const EdgeInsets.all(16),
            color: Colors.white,
            child: Column(
              children: [
                Text(_statusMessage, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                const SizedBox(height: 10),
                if (_authStep > 0) ...[
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: [
                      _colorBox(_detectedColors[0]),
                      _colorBox(_detectedColors[1]),
                      _colorBox(_detectedColors[2]),
                      _colorBox(_detectedColors[3]),
                    ],
                  ),
                  const SizedBox(height: 20),
                ],
                ElevatedButton(
                  onPressed: _authStep == 2 ? () {
                    // TODO: 承認処理 (Firestore更新)
                    Navigator.pop(context);
                  } : null, 
                  child: const Text('承認する'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _colorBox(String code) {
    Color c = Colors.grey;
    if (code == "C") c = Colors.cyan;
    if (code == "Y") c = Colors.yellow;
    if (code == "M") c = Colors.purpleAccent; 
    if (code == "G") c = Colors.green;
    return Container(
      width: 40, height: 40,
      decoration: BoxDecoration(color: c, border: Border.all(color: Colors.black), borderRadius: BorderRadius.circular(4)),
      child: Center(child: Text(code, style: const TextStyle(fontWeight: FontWeight.bold))),
    );
  }
}

// ガイド枠描画クラス (倍率反映版)
class GuideOverlayPainter extends CustomPainter {
  final bool isFaceStep;
  final Face? face;
  final Size? imageSize;
  final InputImageRotation rotation;

  GuideOverlayPainter({required this.isFaceStep, this.face, this.imageSize, required this.rotation});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..style = PaintingStyle.stroke..strokeWidth = 3.0;

    if (isFaceStep) {
      // 顔認証モード
      paint.color = Colors.yellow;
      if (face != null && imageSize != null) {
        final double scaleX = size.width / imageSize!.height;
        final double scaleY = size.height / imageSize!.width;
        final rect = Rect.fromLTRB(
          face!.boundingBox.left * scaleX,
          face!.boundingBox.top * scaleY,
          face!.boundingBox.right * scaleX,
          face!.boundingBox.bottom * scaleY
        );
        canvas.drawRect(rect, paint);
      }
    } else {
      // コードスキャンモード: H型ガイド
      paint.color = Colors.white.withOpacity(0.5);
      paint.strokeWidth = 4.0;
      
      final double w = size.width;
      final double h = size.height;
      
      // 比率反映: w*0.52, h/3*0.8
      final double boxW = w * 0.52; 
      final double boxH = (h / 3) * 0.8;
      
      final double left = (w - boxW) / 2;
      final double top = (h - boxH) / 2;
      final double right = left + boxW;
      final double bottom = top + boxH;

      // 四隅の鉤括弧
      final double cornerLen = boxW * 0.15;
      final redPen = Paint()..color = Colors.red..style = PaintingStyle.stroke..strokeWidth = 4.0;
      final bluePen = Paint()..color = Colors.blue..style = PaintingStyle.stroke..strokeWidth = 4.0;

      canvas.drawPath(Path()..moveTo(left, top + cornerLen)..lineTo(left, top)..lineTo(left + cornerLen, top), redPen);
      canvas.drawPath(Path()..moveTo(right - cornerLen, top)..lineTo(right, top)..lineTo(right, top + cornerLen), redPen);
      canvas.drawPath(Path()..moveTo(left, bottom - cornerLen)..lineTo(left, bottom)..lineTo(left + cornerLen, bottom), bluePen);
      canvas.drawPath(Path()..moveTo(right - cornerLen, bottom)..lineTo(right, bottom)..lineTo(right, bottom - cornerLen), bluePen);

      // 中央H型 (縦3:1:5, 横5:1:7:1:5)
      final whiteFill = Paint()..color = Colors.white.withOpacity(0.8)..style = PaintingStyle.fill;
      
      final double unitX = boxW / 19;
      final double unitY = boxH / 9;

      final double hLeftX = left + unitX * 5;
      final double hRightX = left + unitX * 13;
      final double barTopY = top + unitY * 3;
      final double barBottomY = top + unitY * 4;

      canvas.drawRect(Rect.fromLTRB(hLeftX, top, hLeftX + unitX, bottom), whiteFill);
      canvas.drawRect(Rect.fromLTRB(hRightX, top, hRightX + unitX, bottom), whiteFill);
      canvas.drawRect(Rect.fromLTRB(hLeftX + unitX, barTopY, hRightX, barBottomY), whiteFill);
    }
  }
  @override
  bool shouldRepaint(covariant GuideOverlayPainter oldDelegate) => true;
}

// --- ヘルパー関数 ---
class FaceBoxPainter extends CustomPainter {
  final Face face;
  final Size imageSize;
  final InputImageRotation rotation;
  final String name;
  final Color color;
  final bool isGrid; 
  FaceBoxPainter({required this.face, required this.imageSize, required this.rotation, required this.name, required this.color, required this.isGrid});
  @override
  void paint(Canvas canvas, Size size) {
    final bool isRotated = rotation == InputImageRotation.rotation90deg || rotation == InputImageRotation.rotation270deg;
    final double scaleX = size.width / (isRotated ? imageSize.height : imageSize.width);
    final double scaleY = size.height / (isRotated ? imageSize.width : imageSize.height);
    Rect scaleRect(Face face) {
      if (rotation == InputImageRotation.rotation270deg) {
          return Rect.fromLTRB(
              (imageSize.height - face.boundingBox.bottom) * scaleX,
              face.boundingBox.left * scaleY,
              (imageSize.height - face.boundingBox.top) * scaleX,
              face.boundingBox.right * scaleY);
      }
      return Rect.fromLTRB(face.boundingBox.left * scaleX, face.boundingBox.top * scaleY, face.boundingBox.right * scaleX, face.boundingBox.bottom * scaleY);
    }
    final Rect rect = scaleRect(face);
    final paint = Paint()..color = color ..style = PaintingStyle.stroke ..strokeWidth = 3.0;
    canvas.drawRect(rect, paint);
    if (name.isNotEmpty && name != "不明") {
      final textPainter = TextPainter(
        text: TextSpan(text: name, style: TextStyle(color: color, fontSize: 18.0, backgroundColor: const Color.fromRGBO(0, 0, 0, 0.5))),
        textDirection: TextDirection.ltr,
      )..layout();
      textPainter.paint(canvas, Offset(rect.left, rect.top - textPainter.height - 4));
    }
  }
  @override
  bool shouldRepaint(covariant FaceBoxPainter oldDelegate) => true;
}

InputImage? _inputImageFromCameraImage(CameraImage image, InputImageRotation? rotation) {
  if (rotation == null) return null;
  final WriteBuffer allBytes = WriteBuffer();
  for (final Plane plane in image.planes) allBytes.putUint8List(plane.bytes);
  final bytes = allBytes.done().buffer.asUint8List();
  final Size imageSize = Size(image.width.toDouble(), image.height.toDouble());
  final InputImageMetadata metadata = InputImageMetadata(
    size: imageSize,
    rotation: rotation,
    format: InputImageFormatValue.fromRawValue(image.format.raw) ?? InputImageFormat.nv21,
    bytesPerRow: image.planes[0].bytesPerRow,
  );
  return InputImage.fromBytes(bytes: bytes, metadata: metadata);
}

img_lib.Image? _cropFace(CameraImage image, Face face, InputImageRotation rotation) {
  img_lib.Image? convertedImage;

  if (image.format.group == ImageFormatGroup.yuv420) {
    convertedImage = img_lib.Image(
        width: image.width, height: image.height, format: img_lib.Format.uint8, numChannels: 3);
    
    final int width = image.width;
    final int height = image.height;
    final int yRowStride = image.planes[0].bytesPerRow;

    if (image.planes.length == 3) {
      final int uRowStride = image.planes[1].bytesPerRow;
      final int vRowStride = image.planes[2].bytesPerRow;
      final int uPixelStride = image.planes[1].bytesPerPixel ?? 1;
      final int vPixelStride = image.planes[2].bytesPerPixel ?? 1;

      for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
          final int yIndex = y * yRowStride + x;
          final int uvx = x ~/ 2;
          final int uvy = y ~/ 2;
          final int uIndex = uvy * uRowStride + uvx * uPixelStride;
          final int vIndex = uvy * vRowStride + uvx * vPixelStride;

          final int yValue = image.planes[0].bytes[yIndex];
          final int uValue = image.planes[1].bytes[uIndex];
          final int vValue = image.planes[2].bytes[vIndex];

          _setPixelRGB(convertedImage, x, y, yValue, uValue, vValue);
        }
      }
    } else if (image.planes.length == 2) {
      // 2プレーン (Y, UV)
      final int uvRowStride = image.planes[1].bytesPerRow;
      final int uvPixelStride = image.planes[1].bytesPerPixel ?? 2;

      for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
          final int yIndex = y * yRowStride + x;
          final int uvx = x ~/ 2;
          final int uvy = y ~/ 2;
          final int uvIndex = uvy * uvRowStride + uvx * uvPixelStride;

          final int yValue = image.planes[0].bytes[yIndex];
          final int uValue = image.planes[1].bytes[uvIndex];
          final int vValue = image.planes[1].bytes[uvIndex + 1];

          _setPixelRGB(convertedImage, x, y, yValue, uValue, vValue);
        }
      }
    }
  } else if (image.format.group == ImageFormatGroup.bgra8888) {
    final plane = image.planes[0];
    final bgraImage = img_lib.Image.fromBytes(
        width: image.width, height: image.height, bytes: plane.bytes.buffer,
        rowStride: plane.bytesPerRow, order: img_lib.ChannelOrder.bgra);
    convertedImage = img_lib.Image(width: bgraImage.width, height: bgraImage.height);
    for (final pixel in bgraImage) {
      convertedImage.setPixelRgb(pixel.x, pixel.y, pixel.r, pixel.g, pixel.b);
    }
  } else {
    return null;
  }

  final x = face.boundingBox.left.toInt().clamp(0, convertedImage.width - 1);
  final y = face.boundingBox.top.toInt().clamp(0, convertedImage.height - 1);
  final w = face.boundingBox.width.toInt().clamp(0, convertedImage.width - x);
  final h = face.boundingBox.height.toInt().clamp(0, convertedImage.height - y);
  img_lib.Image croppedFace = img_lib.copyCrop(convertedImage, x: x, y: y, width: w, height: h);
  
  img_lib.Image rotatedImage;
  if (rotation == InputImageRotation.rotation270deg) {
    rotatedImage = img_lib.copyRotate(croppedFace, angle: -90);
  } else if (rotation == InputImageRotation.rotation90deg) {
    rotatedImage = img_lib.copyRotate(croppedFace, angle: 90);
  } else {
    rotatedImage = croppedFace;
  }
  
  return img_lib.copyResize(rotatedImage, width: 112, height: 112);
}

void _setPixelRGB(img_lib.Image image, int x, int y, int yValue, int uValue, int vValue) {
  int r = (yValue + 1.402 * (vValue - 128)).round().clamp(0, 255);
  int g = (yValue - 0.344136 * (uValue - 128) - 0.714136 * (vValue - 128)).round().clamp(0, 255);
  int b = (yValue + 1.772 * (uValue - 128)).round().clamp(0, 255);
  image.setPixelRgb(x, y, r, g, b);
}
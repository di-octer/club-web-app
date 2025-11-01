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
import 'package:tensorflow_face_verification/tensorflow_face_verification.dart'; // 特徴量生成
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

// --- Base64デコード (script.js (v2) 互換) ---
Float32List _decodeBase64(String base64String) {
  final String binaryString = utf8.decode(base64Decode(base64String), allowMalformed: true);
  final len = binaryString.length;
  final uint8Array = Uint8List(len);
  
  // ★ 修正: 'let' (JS) -> 'int' (Dart)
  for (int i = 0; i < len; i++) {
    uint8Array[i] = binaryString.codeUnitAt(i);
  }
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
Future<void> _returnToBrowser(String baseUrl, {String? cardId, String? error}) async {
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
          String idm = felica.idm.map((e) => e.toRadixString(16).padLeft(2, '0')).join('').toUpperCase();
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

class _AdminHomePageState extends State<AdminHomePage> {
  int _selectedIndex = 0; 
  static final List<Widget> _widgetOptions = <Widget>[
    const StatusScreen(),     
    const GpsAdminScreen(),   
    const FaceAdminScreen(),  
  ];
  void _onItemTapped(int index) {
    setState(() { _selectedIndex = index; });
  }
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('管理者用 統合アプリ')),
      body: Center(child: _widgetOptions.elementAt(_selectedIndex)),
      bottomNavigationBar: BottomNavigationBar(
        items: const <BottomNavigationBarItem>[
          BottomNavigationBarItem(icon: Icon(Icons.radar), label: 'ステータス'),
          BottomNavigationBarItem(icon: Icon(Icons.location_on), label: 'GPS管理'),
          BottomNavigationBarItem(icon: Icon(Icons.face), label: '顔登録管理'),
        ],
        currentIndex: _selectedIndex,
        selectedItemColor: Colors.indigo[800],
        onTap: _onItemTapped,
      ),
    );
  }
}

// --- 6. ステータス画面 (タブ1) ---
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
            const Text('認証エージェント 起動中', style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold), textAlign: TextAlign.center),
            const SizedBox(height: 10),
            const Text('（Webアプリ/ユーザーアプリからの認証リクエストを待機しています）', textAlign: TextAlign.center, style: TextStyle(fontSize: 14, color: Colors.grey)),
            const SizedBox(height: 30),
            ValueListenableBuilder<String>(
              valueListenable: _bleStatus,
              builder: (context, status, child) => StatusCard(title: 'ビーコン (BLE)', status: status),
            ),
            const SizedBox(height: 10),
            ValueListenableBuilder<String>(
              valueListenable: _applinkStatus,
              builder: (context, status, child) => StatusCard(title: 'Web連携 (Deep Link)', status: status),
            ),
             const SizedBox(height: 10),
            ValueListenableBuilder<String>(
              valueListenable: _nfcStatus,
              builder: (context, status, child) => StatusCard(title: 'ICカード (NFC)', status: status),
            ),
          ],
        ),
      ),
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

// --- 7. GPS管理画面 (タブ2) ---
class GpsAdminScreen extends StatefulWidget {
  const GpsAdminScreen({super.key});
  @override
  State<GpsAdminScreen> createState() => _GpsAdminScreenState();
}

class _GpsAdminScreenState extends State<GpsAdminScreen> {
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

// --- 8. 顔登録管理画面 (タブ3) ---
class FaceAdminScreen extends StatefulWidget {
  const FaceAdminScreen({super.key});
  @override
  State<FaceAdminScreen> createState() => _FaceAdminScreenState();
}

class _FaceAdminScreenState extends State<FaceAdminScreen> {
  final _nameController = TextEditingController();
  int _scanStep = 0; 
  final List<String> _scanInstructions = [
    "", "1/5: 正面を向いてください", "2/5: 顔を「左」に向けてください", "3/5: 顔を「右」に向けてください",
    "4/5: 顔を「上」に向けてください", "5/5: 顔を「下」に向けてください",
  ];
  String _statusMessage = '名前を入力して登録を開始してください。';
  bool _isLoading = false;
  List<Float32List> _scanDescriptors = [];
  String _scanThumbnailBase64 = ''; 
  CameraController? _cameraController;
  late FaceDetector _faceDetector;
  
  // ★ 修正: 'TFFaceVerification' -> 'TensorflowFaceVerification'
  final FaceVerification _faceNetService = FaceVerification.instance;

  bool _isDetecting = false;
  Size? _cameraImageSize;
  Face? _detectedFace;
  img_lib.Image? _croppedFaceImage;

  @override
  void initState() {
    super.initState();
    _initializeServices();
  }

  @override
  void dispose() {
    _cameraController?.dispose();
    _faceDetector.close();
    super.dispose();
  }

  Future<void> _initializeServices() async {
    setState(() { _isLoading = true; _statusMessage = 'カメラとAIモデルを初期化中...'; });
    _faceDetector = FaceDetector(
      options: FaceDetectorOptions(
        enableContours: false,
        enableLandmarks: false,
        performanceMode: FaceDetectorMode.fast,
      ),
    );
    final cameras = await availableCameras();
    final frontCamera = cameras.firstWhere(
      (c) => c.lensDirection == CameraLensDirection.front,
      orElse: () => cameras.first,
    );
    _cameraController = CameraController(
      frontCamera,
      ResolutionPreset.medium,
      enableAudio: false,
    );
    await _cameraController!.initialize();
    _cameraImageSize = _cameraController!.value.previewSize;
    _cameraController!.startImageStream(_processImageStream);
    _resetState('名前を入力して登録を開始してください。');
  }

  void _processImageStream(CameraImage cameraImage) async {
    if (_isDetecting || _scanStep == 0) return;
    _isDetecting = true;
    
    // ★ 修正: _inputImageFromCameraImage ヘルパーを呼び出す
    final inputImage = _inputImageFromCameraImage(cameraImage);
    
    try {
      final faces = await _faceDetector.processImage(inputImage);
      if (faces.isNotEmpty) {
        _detectedFace = faces.reduce((a, b) => a.boundingBox.width > b.boundingBox.width ? a : b);
        
        // ★ 修正: _cropFace ヘルパーを呼び出す
        _croppedFaceImage = _cropFace(cameraImage, _detectedFace!);
        
      } else {
        _detectedFace = null;
        _croppedFaceImage = null;
      }
    } catch (e) {
      debugPrint('顔検出エラー: $e');
    } finally {
      if (mounted) setState(() {});
      _isDetecting = false;
    }
  }

  Future<void> _onRegisterButtonPressed() async {
    final newName = _nameController.text.trim();
    if (_scanStep == 0) {
      if (newName.isEmpty) {
        _showErrorDialog('入力エラー', '名前を入力してください。');
        return;
      }
      if (globalFaces.value.any((f) => f.label == newName)) {
        if (await _showConfirmDialog('上書き確認', '「$newName」さんは既に登録されています。上書きしますか？') == false) return;
      }
      _scanDescriptors = [];
      _scanThumbnailBase64 = '';
      setState(() {
        _scanStep = 1;
        _statusMessage = _scanInstructions[_scanStep];
      });
      return;
    }
    if (_detectedFace == null || _croppedFaceImage == null) {
      _showErrorDialog('スキャンエラー', '${_scanInstructions[_scanStep]} の顔を検出できません。');
      return;
    }
    setState(() { _isLoading = true; _statusMessage = 'スキャン中... ($_scanStep/5)'; });
    try {
      final List<double> descriptor = await _faceNetService.extractFaceEmbedding(
        _croppedFaceImage!,
      );
      _scanDescriptors.add(Float32List.fromList(descriptor));
    } catch (e) {
      _showErrorDialog('特徴量エラー', '顔の特徴量の生成に失敗しました: $e');
      _resetState('エラーが発生しました。', clearName: false);
      return;
    }
    if (_scanStep == 1) {
      final jpgBytes = img_lib.encodeJpg(_croppedFaceImage!, quality: 80);
      _scanThumbnailBase64 = 'data:image/jpeg;base64,${base64Encode(jpgBytes)}';
    }
    _scanStep++;
    if (_scanStep > 5) {
      await _saveFaceToFirestore(newName, _scanDescriptors, _scanThumbnailBase64);
    } else {
      setState(() {
        _isLoading = false;
        _statusMessage = _scanInstructions[_scanStep];
      });
    }
  }

  Future<void> _saveFaceToFirestore(String label, List<Float32List> descriptors, String thumbnailDataUrl) async {
    setState(() { _statusMessage = 'データベースに保存中...'; });
    
    String encodeBase64(Float32List floatList) {
      final uint8Array = floatList.buffer.asUint8List();
      // ★ 修正: JSの atob/btoa 互換のDartエンコード
      final binaryString = String.fromCharCodes(uint8Array);
      return base64Encode(utf8.encode(binaryString));
    }
        
    try {
      final dataToSave = {
        'label': label,
        'thumbnail': thumbnailDataUrl, 
        'descriptors': descriptors.map((d) => encodeBase64(d)).toList(),
      };
      await db.collection("faces").doc(label).set(dataToSave);
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
      _showErrorDialog('DB保存エラー', 'データベースへの保存に失敗しました: $e');
      _resetState('エラーが発生しました。', clearName: false);
    }
  }
  
  void _resetState(String message, {bool clearName = true}) {
    setState(() {
      _scanStep = 0;
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
    if (_scanStep == 0) return '1. スキャン開始 (5段階)';
    return 'スキャン ($_scanStep/5)';
  }

  @override
  Widget build(BuildContext context) {
    if (_cameraController == null || !_cameraController!.value.isInitialized || _isLoading && _scanStep == 0) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const CircularProgressIndicator(),
            const SizedBox(height: 10),
            Text(_statusMessage),
          ],
        ),
      );
    }
    return ListView(
      padding: const EdgeInsets.all(16.0),
      children: [
        const Text('顔認証 (登録フェーズ)', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
        const SizedBox(height: 10),
        SizedBox(
          width: 320,
          height: 240,
          child: Stack(
            fit: StackFit.expand,
            children: [
              CameraPreview(_cameraController!),
              if (_detectedFace != null && _cameraImageSize != null)
                CustomPaint(
                  painter: FaceBoxPainter(
                    face: _detectedFace!,
                    imageSize: _cameraImageSize!,
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        Text(_statusMessage, style: const TextStyle(fontWeight: FontWeight.bold), textAlign: TextAlign.center),
        const SizedBox(height: 10),
        TextField(
          controller: _nameController,
          decoration: const InputDecoration(labelText: '登録名', border: OutlineInputBorder()),
          enabled: _scanStep == 0,
        ),
        const SizedBox(height: 10),
        ElevatedButton(
          onPressed: _isLoading ? null : _onRegisterButtonPressed,
          style: ElevatedButton.styleFrom(
            padding: const EdgeInsets.symmetric(vertical: 16.0),
            backgroundColor: _scanStep == 0 ? Colors.indigo : Colors.amber[700],
          ),
          child: _isLoading 
              ? const CircularProgressIndicator(color: Colors.white)
              : Text(_getButtonText()),
        ),
        const Divider(height: 40),
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
                ImageProvider imageProvider;
                if (face.thumbnail.startsWith('data:image')) {
                  imageProvider = MemoryImage(base64Decode(face.thumbnail.split(',').last));
                } else {
                  // これからのTODO: assets/placeholder.png を pubspec.yaml に追加する必要があります
                  imageProvider = const AssetImage('assets/placeholder.png'); 
                }
                return Card(
                  margin: const EdgeInsets.symmetric(vertical: 4.0),
                  child: ListTile(
                    leading: Image(
                      image: imageProvider,
                      width: 60, height: 80, fit: BoxFit.cover,
                      errorBuilder: (context, error, stackTrace) => 
                          Container(width: 60, height: 80, color: Colors.grey[300], child: const Icon(Icons.no_photography)),
                    ),
                    title: Text(face.label),
                    trailing: IconButton(
                      icon: const Icon(Icons.delete, color: Colors.red),
                      onPressed: _isLoading ? null : () async {
                        if (await _showConfirmDialog('削除確認', '本当に「${face.label}」さんを削除しますか？')) {
                          await deleteFaceFromFirestore(face.label);
                          _resetState('「${face.label}」さんを削除しました。');
                        }
                      },
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

// --- 9. ヘルパー関数群 (ファイルの末尾) ---

// ★ 顔の枠を描画するヘルパーウィジェット ★
class FaceBoxPainter extends CustomPainter {
  final Face face;
  final Size imageSize;
  FaceBoxPainter({required this.face, required this.imageSize});
  @override
  void paint(Canvas canvas, Size size) {
    final scaleX = size.width / imageSize.width;
    final scaleY = size.height / imageSize.height;
    final rect = Rect.fromLTRB(
      face.boundingBox.left * scaleX,
      face.boundingBox.top * scaleY,
      face.boundingBox.right * scaleX,
      face.boundingBox.bottom * scaleY,
    );
    final paint = Paint()
      ..color = Colors.green
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3.0;
    canvas.drawRect(rect, paint);
  }
  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => true;
}

// ★ カメラ画像をMLKitのInputImageに変換するヘルパー ★
InputImage _inputImageFromCameraImage(CameraImage image) {
  final WriteBuffer allBytes = WriteBuffer();
  for (final Plane plane in image.planes) {
    allBytes.putUint8List(plane.bytes);
  }
  final bytes = allBytes.done().buffer.asUint8List();
  final Size imageSize = Size(image.width.toDouble(), image.height.toDouble());
  
  // これからのTODO: 回転 (rotation) はデバイスの向きによって調整が必要です
  final InputImageRotation imageRotation = InputImageRotation.rotation0deg; 
  
  // ★ 修正: 'InputImageData' -> 'InputImageMetadata'
  final InputImageMetadata metadata = InputImageMetadata(
    size: imageSize,
    rotation: imageRotation,
    format: InputImageFormatValue.fromRawValue(image.format.raw) ?? InputImageFormat.nv21,
    bytesPerRow: image.planes[0].bytesPerRow,
  );

  return InputImage.fromBytes(bytes: bytes, metadata: metadata);
}

// ★ カメラ画像を (TFLite用) img_lib.Image に変換するヘルパー ★
img_lib.Image _cropFace(CameraImage image, Face face) {
  // これからのTODO: YUVからRGBへの変換を正しく実装する必要があります
  // この暫定対応では、顔の特徴量生成 (getFaceEmbedding) が失敗します。
  
  // ★ 修正: 未使用変数の警告を削除 (暫定対応)
  // final x = face.boundingBox.left.toInt();
  // final y = face.boundingBox.top.toInt();
  // final w = face.boundingBox.width.toInt();
  // final h = face.boundingBox.height.toInt();
  
  // 暫定対応: TFLiteが要求するサイズ (112x112) の空の画像を返す
  return img_lib.Image(width: 112, height: 112, numChannels: 3); 
}
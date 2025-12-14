import 'package:flutter/material.dart';
import 'dart:async';
// import 'dart:convert'; // 使っていないので削除
// import 'dart:typed_data'; // 使っていないので削除
import 'dart:math' as math;
import 'package:firebase_core/firebase_core.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:geolocator/geolocator.dart';
// import 'package:flutter_ble_central_chusiao/flutter_ble_central_chusiao.dart'; // ★削除: 存在しないパッケージのため
import 'package:camera/camera.dart';
// import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';
// import 'package:tflite_flutter/tflite_flutter.dart';
// import 'package:image/image.dart' as img_lib;

// --- 定数・設定 ---
const String ADMIN_SERVICE_UUID = "0000180F-0000-1000-8000-00805F9B34FB"; // 管理者アプリと合わせる
const double GPS_THRESHOLD = 0.00005; // 許容誤差

// --- グローバル変数 ---
late FaceVerification _faceService;
// final ValueNotifier<String> _statusLog = ValueNotifier("準備中..."); // ★削除: 未使用のため

// --- メイン関数 ---
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();
  await FaceVerification.init(); // モデルロード
  _faceService = FaceVerification.instance;
  runApp(const UserApp());
}

class UserApp extends StatelessWidget {
  const UserApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '部員用アプリ',
      theme: ThemeData(primarySwatch: Colors.blue, useMaterial3: true),
      home: const HomeScreen(),
    );
  }
}

// --- ホーム画面 ---
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final TextEditingController _nameController = TextEditingController(); // 簡易的なユーザー識別
  
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('出席認証')),
      body: Padding(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            TextField(
              controller: _nameController,
              decoration: const InputDecoration(labelText: 'あなたの名前', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 30),
            const Text("認証方法を選択してください", style: TextStyle(fontSize: 16)),
            const SizedBox(height: 20),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                _AuthButton(
                  icon: Icons.qr_code, 
                  label: "カラーコード認証", 
                  color: Colors.orange,
                  onPressed: () => _startAuthSequence(context, 'code'),
                ),
                _AuthButton(
                  icon: Icons.nfc, 
                  label: "NFC認証", 
                  color: Colors.blue,
                  onPressed: () => _startAuthSequence(context, 'nfc'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  void _startAuthSequence(BuildContext context, String type) {
    if (_nameController.text.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("名前を入力してください")));
      return;
    }
    Navigator.push(
      context, 
      MaterialPageRoute(builder: (_) => AuthProcessScreen(userName: _nameController.text, authType: type))
    );
  }
}

class _AuthButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onPressed;
  const _AuthButton({required this.icon, required this.label, required this.color, required this.onPressed});

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      style: ElevatedButton.styleFrom(
        backgroundColor: color, 
        foregroundColor: Colors.white,
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 20),
      ),
      onPressed: onPressed,
      child: Column(
        children: [Icon(icon, size: 40), const SizedBox(height: 10), Text(label)],
      ),
    );
  }
}

// --- 認証プロセス画面 ---
class AuthProcessScreen extends StatefulWidget {
  final String userName;
  final String authType; // 'code' or 'nfc'
  const AuthProcessScreen({super.key, required this.userName, required this.authType});

  @override
  State<AuthProcessScreen> createState() => _AuthProcessScreenState();
}

class _AuthProcessScreenState extends State<AuthProcessScreen> {
  int _step = 0; // 0:GPS/BLE, 1:Face, 2:WaitingAdmin, 3:Success
  String _message = "環境情報を確認中...";
  CameraController? _cameraController;
  bool _isProcessing = false;
  String? _requestId;

  @override
  void initState() {
    super.initState();
    _checkEnvironment();
  }

  @override
  void dispose() {
    _cameraController?.dispose();
    super.dispose();
  }

  // ステップ1: GPSとビーコンの確認
  Future<void> _checkEnvironment() async {
    setState(() { _message = "GPSとビーコンを確認中..."; });
    
    try {
      // 1. GPS確認 (登録済みエリア内か)
      final position = await _determinePosition();
      final areasSnapshot = await FirebaseFirestore.instance.collection('gps_areas').get();
      bool inArea = false;
      
      for (var doc in areasSnapshot.docs) {
        final data = doc.data();
        if (_isInsideArea(position, data)) {
          inArea = true;
          break;
        }
      }
      
      if (!inArea) throw Exception("登録エリア外です");

      // 2. BLEビーコン確認 (管理者アプリが近くにいるか)
      // 注: iOSのBLEスキャンは権限周りが厳しいため、ここでは簡易的な実装とします
      // 実際には flutter_blue_plus 等で ADMIN_SERVICE_UUID をスキャンします
      // await _scanForAdminBeacon(); 
      
      // 両方OKなら顔認証へ
      _initCamera();
      
    } catch (e) {
      _showError("環境チェック失敗: $e");
    }
  }

  bool _isInsideArea(Position pos, Map<String, dynamic> area) {
    double minLat = math.min(area['lat1'], area['lat2']) - GPS_THRESHOLD;
    double maxLat = math.max(area['lat1'], area['lat2']) + GPS_THRESHOLD;
    double minLon = math.min(area['lon1'], area['lon2']) - GPS_THRESHOLD;
    double maxLon = math.max(area['lon1'], area['lon2']) + GPS_THRESHOLD;
    return pos.latitude >= minLat && pos.latitude <= maxLat &&
           pos.longitude >= minLon && pos.longitude <= maxLon;
  }

  Future<Position> _determinePosition() async {
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) throw Exception('位置情報サービスが無効です');
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) throw Exception('位置情報権限が拒否されました');
    }
    return await Geolocator.getCurrentPosition();
  }

  // ステップ2: 本人確認（顔認証）
  Future<void> _initCamera() async {
    setState(() { _step = 1; _message = "本人確認のため顔を映してください"; });
    final cameras = await availableCameras();
    final frontCam = cameras.firstWhere((c) => c.lensDirection == CameraLensDirection.front);
    _cameraController = CameraController(frontCam, ResolutionPreset.medium, enableAudio: false, imageFormatGroup: ImageFormatGroup.yuv420);
    await _cameraController!.initialize();
    if (!mounted) return;
    setState(() {});
    
    // ストリーム開始
    _cameraController!.startImageStream((image) => _processCameraImage(image));
  }

  void _processCameraImage(CameraImage image) async {
    if (_isProcessing) return;
    _isProcessing = true;

    try {
      // 登録済み顔データと比較 (Adminアプリのロジックを流用)
      // 1. 画像変換 -> 2. 特徴量抽出 -> 3. Firestoreの 'faces' と照合
      // ここでは簡略化のため、照合成功したと仮定して進めます
      
      bool isMatch = await _faceService.verifyUser(image, widget.userName);
      
      if (isMatch) {
        await _cameraController!.stopImageStream();
        _sendAuthRequest();
      }
    } catch (e) {
      debugPrint("Error: $e");
    } finally {
      _isProcessing = false;
    }
  }

  // ステップ3: リクエスト送信と待機
  Future<void> _sendAuthRequest() async {
    setState(() { _step = 2; _message = "管理者に承認を求めています...\n画面を見せてください"; });
    
    final docRef = await FirebaseFirestore.instance.collection('auth_requests').add({
      'userName': widget.userName,
      'authType': widget.authType,
      'status': 'pending',
      'requestTimestamp': FieldValue.serverTimestamp(),
      'gps_valid': true,
      'ble_valid': true,
      'face_valid': true, // 本人確認済み
    });

    setState(() { _requestId = docRef.id; });
    debugPrint("Request Sent ID: $_requestId"); // ★追加: 変数を使用することでワーニングを解消

    // 管理者の承認を監視
    docRef.snapshots().listen((snapshot) {
      if (!snapshot.exists) return;
      final data = snapshot.data();
      if (data?['status'] == 'approved') {
        _showSuccess();
      } else if (data?['status'] == 'rejected') {
        _showError("管理者に否認されました");
      }
    });
  }

  void _showSuccess() {
    setState(() { _step = 3; _message = "認証成功！\n出席が記録されました。"; });
  }

  void _showError(String msg) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => AlertDialog(
        title: const Text("エラー"),
        content: Text(msg),
        actions: [
          TextButton(onPressed: () {
            Navigator.pop(context); // ダイアログ閉じる
            Navigator.pop(context); // ホームへ戻る
          }, child: const Text("戻る"))
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("認証プロセス")),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // ステップに応じた表示
            if (_step == 1 && _cameraController != null && _cameraController!.value.isInitialized)
              SizedBox(
                height: 300,
                width: 300,
                child: ClipOval(child: CameraPreview(_cameraController!)),
              ),
            if (_step == 2 && widget.authType == 'code')
              Container(
                width: 200, height: 200, color: Colors.white,
                child: const Center(child: Text("カラーコードを表示\n(ここに描画)")),
                // 実際はここにユーザー固有のカラーコードを表示する
              ),
            
            const SizedBox(height: 30),
            if (_step == 2) const CircularProgressIndicator(),
            const SizedBox(height: 20),
            
            Text(
              _message, 
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)
            ),
            
            if (_step == 3)
              const Padding(
                padding: EdgeInsets.only(top: 30),
                child: Icon(Icons.check_circle, color: Colors.green, size: 80),
              ),
          ],
        ),
      ),
    );
  }
}

// --- 顔認証サービス (簡易版: Adminアプリのロジックを移植) ---
class FaceVerification {
  static late FaceVerification instance;
  static Future<void> init() async {
    // TFLiteモデルロードなど
    instance = FaceVerification();
  }
  
  // ユーザー名と一致するか判定
  Future<bool> verifyUser(CameraImage image, String targetName) async {
    // 1. 画像から特徴量抽出
    // 2. Firestoreの 'faces' コレクションから targetName のドキュメントを取得
    // 3. ユークリッド距離計算
    // 4. 閾値以下なら true
    
    // ダミー実装 (実際はAdminアプリの _cropFace, _getEmbedding, _findBestMatch を使用)
    await Future.delayed(const Duration(milliseconds: 500));
    return true; // 常に成功としてシミュレート
  }
}
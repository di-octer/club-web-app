import 'package:flutter/material.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:math' as math;
import 'package:firebase_core/firebase_core.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:geolocator/geolocator.dart';
import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';
import 'package:tflite_flutter/tflite_flutter.dart';
import 'package:image/image.dart' as img_lib;

// --- 定数 ---
const String ADMIN_SERVICE_UUID = "180f"; 
const double GPS_RADIUS_METERS = 100.0;

// --- グローバル変数 ---
late FaceVerification _faceService;

// --- メイン関数 ---
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();
  await FaceVerification.init();
  _faceService = FaceVerification.instance;
  runApp(const UserApp());
}

class UserApp extends StatelessWidget {
  const UserApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '統合アプリ',
      theme: ThemeData(
        primarySwatch: Colors.indigo,
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFFF0F2F5),
      ),
      home: const HomeScreen(),
    );
  }
}

// ==========================================
//   1. ホーム画面 (Dashboard)
// ==========================================
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('統合アプリ', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        backgroundColor: Colors.indigo,
        actions: [
          IconButton(
            icon: const Icon(Icons.settings, color: Colors.white),
            onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const SettingsScreen())),
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _WelcomeCard(),
            const SizedBox(height: 20),
            const Text("機能一覧", style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Colors.black87)),
            const SizedBox(height: 10),
            
            _MenuCard(
              icon: Icons.camera_alt, 
              title: "出席認証", 
              subtitle: "GPS + 顔認証で出席",
              color: Colors.blue,
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const AttendanceEntryScreen())),
            ),
            _MenuCard(
              icon: Icons.calendar_month, 
              title: "出席履歴の確認", 
              subtitle: "過去の出席状況をチェック",
              color: Colors.green,
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const CheckHistoryScreen())),
            ),
            _MenuCard(
              icon: Icons.menu_book, 
              title: "カリキュラム学習", 
              subtitle: "教材と課題",
              color: Colors.orange,
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const CurriculumScreen())),
            ),
            _MenuCard(
              icon: Icons.edit_note, 
              title: "欠席・遅刻連絡", 
              subtitle: "フォームから送信",
              color: Colors.teal,
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const FormScreen())),
            ),
            _MenuCard(
              icon: Icons.event, 
              title: "活動カレンダー", 
              subtitle: "予定を確認",
              color: Colors.purple,
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const CalendarScreen())),
            ),
            _MenuCard(
              icon: Icons.collections, 
              title: "ポートフォリオ", 
              subtitle: "作品集",
              color: Colors.pink,
              onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const PortfolioScreen())),
            ),
          ],
        ),
      ),
    );
  }
}

class _WelcomeCard extends StatelessWidget {
  const _WelcomeCard();
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.1), blurRadius: 10, offset: const Offset(0, 2))],
      ),
      child: const Column(
        children: [
          Text("ようこそ！", style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
          SizedBox(height: 10),
          Text("部の活動（出席、学習、交流、成果発表）を一つのアプリで完結させます。", textAlign: TextAlign.center, style: TextStyle(color: Colors.black54)),
        ],
      ),
    );
  }
}

class _MenuCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  final Color color;
  final VoidCallback onTap;

  const _MenuCard({required this.icon, required this.title, required this.subtitle, required this.color, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 2,
      margin: const EdgeInsets.only(bottom: 15),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      child: ListTile(
        contentPadding: const EdgeInsets.all(15),
        leading: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: color.withOpacity(0.1), borderRadius: BorderRadius.circular(8)),
          child: Icon(icon, color: color, size: 30),
        ),
        title: Text(title, style: const TextStyle(fontWeight: FontWeight.bold)),
        subtitle: Text(subtitle),
        trailing: const Icon(Icons.chevron_right),
        onTap: onTap,
      ),
    );
  }
}

// ==========================================
//   2. 出席認証：名前入力 & 方式選択画面
// ==========================================
class AttendanceEntryScreen extends StatefulWidget {
  const AttendanceEntryScreen({super.key});
  @override
  State<AttendanceEntryScreen> createState() => _AttendanceEntryScreenState();
}

class _AttendanceEntryScreenState extends State<AttendanceEntryScreen> {
  final TextEditingController _nameController = TextEditingController();

  void _startAuthSequence(String type) {
    final name = _nameController.text.trim();
    if (name.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("名前を入力してください")));
      return;
    }
    FocusScope.of(context).unfocus();
    
    Navigator.push(
      context, 
      MaterialPageRoute(builder: (_) => AuthProcessScreen(userName: name, authType: type))
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('出席認証')),
      body: Padding(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.face_retouching_natural, size: 80, color: Colors.indigo),
            const SizedBox(height: 20),
            const Text("登録名を入力してください", style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            const SizedBox(height: 10),
            TextField(
              controller: _nameController,
              decoration: const InputDecoration(labelText: '名前 (例: 山田太郎)', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 40),
            const Text("認証方法を選択", style: TextStyle(color: Colors.grey)),
            const SizedBox(height: 15),
            Row(
              children: [
                Expanded(child: _AuthOptionButton(icon: Icons.qr_code, label: "カラーコード", color: Colors.orange, onPressed: () => _startAuthSequence('code'))),
                const SizedBox(width: 15),
                Expanded(child: _AuthOptionButton(icon: Icons.nfc, label: "NFC (ICカード)", color: Colors.blue, onPressed: () => _startAuthSequence('nfc'))),
              ],
            )
          ],
        ),
      ),
    );
  }
}

class _AuthOptionButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final Color color;
  final VoidCallback onPressed;
  const _AuthOptionButton({required this.icon, required this.label, required this.color, required this.onPressed});

  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      style: ElevatedButton.styleFrom(
        backgroundColor: color,
        foregroundColor: Colors.white,
        padding: const EdgeInsets.symmetric(vertical: 20),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
      onPressed: onPressed,
      child: Column(
        children: [Icon(icon, size: 30), const SizedBox(height: 8), Text(label, style: const TextStyle(fontWeight: FontWeight.bold))],
      ),
    );
  }
}

// ==========================================
//   3. 認証プロセス (GPS -> BLE -> Face -> Request)
// ==========================================
class AuthProcessScreen extends StatefulWidget {
  final String userName;
  final String authType;
  const AuthProcessScreen({super.key, required this.userName, required this.authType});

  @override
  State<AuthProcessScreen> createState() => _AuthProcessScreenState();
}

class _AuthProcessScreenState extends State<AuthProcessScreen> {
  int _step = 0; 
  String _message = "環境情報を確認中...";
  CameraController? _cameraController;
  bool _isProcessingFace = false;
  String? _requestId;
  List<String> _myColorCode = [];
  InputImageRotation _cameraRotation = InputImageRotation.rotation270deg;
  bool _isCheckingStatus = false; 

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

  // --- ステップ1: 環境チェック ---
  Future<void> _checkEnvironment() async {
    try {
      setState(() { _message = "GPSエリアを確認中..."; });
      await _checkGps();

      setState(() { _message = "管理者のビーコンを捜索中..."; });
      await _checkBle();

      _initCamera();
      
    } catch (e) {
      _showError("環境チェック失敗:\n$e");
    }
  }

  Future<void> _checkGps() async {
    final position = await _determinePosition();
    final areasSnapshot = await FirebaseFirestore.instance.collection('gps_areas').where('isActive', isEqualTo: true).get();
    
    if (areasSnapshot.docs.isEmpty) {
      debugPrint("有効なGPSエリアがありません。デバッグのため通過します。");
      return; 
    }

    bool inArea = false;
    for (var doc in areasSnapshot.docs) {
      final data = doc.data();
      final double lat = (data['lat1'] ?? 0.0).toDouble();
      final double lon = (data['lon1'] ?? 0.0).toDouble();
      
      final double dist = Geolocator.distanceBetween(position.latitude, position.longitude, lat, lon);
      if (dist <= GPS_RADIUS_METERS) {
        inArea = true;
        break;
      }
    }
    
    if (!inArea) {
      // debugPrint("エリア外(デバッグ通過)");
      // 本番用: throw Exception("登録エリアの外にいます。\n活動場所に近づいてください。");
    }
  }

  Future<void> _checkBle() async {
    if (await FlutterBluePlus.isSupported == false) {
      debugPrint("Bluetooth非対応(デバッグ通過)");
      return;
    }
    final adapterState = await FlutterBluePlus.adapterState.first;
    if (adapterState != BluetoothAdapterState.on) {
      debugPrint("Bluetooth OFF(デバッグ通過)");
      return;
    }

    bool adminFound = false;
    final completer = Completer<void>();

    var subscription = FlutterBluePlus.scanResults.listen((results) {
      for (ScanResult r in results) {
        if (r.advertisementData.serviceUuids.contains(Guid(ADMIN_SERVICE_UUID))) {
          if (!adminFound) {
            adminFound = true;
            completer.complete();
          }
        }
      }
    });

    await FlutterBluePlus.startScan(timeout: const Duration(seconds: 4));
    
    if (!completer.isCompleted) {
      debugPrint("管理者ビーコン見つからず(デバッグ通過)");
    }
    
    await subscription.cancel();
  }

  Future<Position> _determinePosition() async {
    bool serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) throw Exception('位置情報サービスが無効です');
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
      if (permission == LocationPermission.denied) throw Exception('位置情報権限が拒否されました');
    }
    return await Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.high);
  }

  // --- ステップ2: 顔認証 ---
  Future<void> _initCamera() async {
    setState(() { _step = 1; _message = "本人確認のため顔を映してください"; });
    
    try {
      final cameras = await availableCameras();
      final frontCam = cameras.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front,
        orElse: () => cameras.first
      );
      
      _cameraRotation = InputImageRotationValue.fromRawValue(frontCam.sensorOrientation) 
          ?? InputImageRotation.rotation270deg;

      _cameraController = CameraController(
        frontCam, 
        ResolutionPreset.medium, 
        enableAudio: false, 
        imageFormatGroup: ImageFormatGroup.yuv420
      );
      
      await _cameraController!.initialize();
      if (!mounted) return;
      setState(() {});
      
      _cameraController!.startImageStream(_processCameraImage);
      
    } catch (e) {
      _showError("カメラ起動エラー: $e");
    }
  }

  void _processCameraImage(CameraImage image) async {
    if (_isProcessingFace || !mounted) return;
    _isProcessingFace = true;

    try {
      bool isMatch = await _faceService.verifyUser(image, widget.userName, _cameraRotation);
      
      if (isMatch) {
        await _cameraController!.stopImageStream();
        if (mounted) {
           _generateColorCode();
           _sendAuthRequest();
        }
      }
    } catch (e) {
      debugPrint("Face Auth Error: $e");
    } finally {
      if (mounted) _isProcessingFace = false;
    }
  }

  void _generateColorCode() {
    const colors = ['C', 'Y', 'M', 'G'];
    final random = math.Random();
    _myColorCode = List.generate(4, (_) => colors[random.nextInt(colors.length)]);
  }

  // --- ステップ3: リクエスト送信と待機 ---
  Future<void> _sendAuthRequest() async {
    setState(() { _step = 2; _message = "管理者に画面を見せてください"; });
    
    try {
      String finalAuthType = widget.authType;
      if (widget.authType == 'code') {
        finalAuthType = "code,${_myColorCode.join(',')}";
      }

      // ★修正: platform, gps_valid, face_valid を完全に削除
      final docRef = await FirebaseFirestore.instance.collection('auth_requests').add({
        'userName': widget.userName,
        'authType': finalAuthType,
        'status': 'pending',
        'requestTimestamp': FieldValue.serverTimestamp(),
      });

      setState(() { _requestId = docRef.id; });

    } catch (e) {
      _showError("リクエスト送信エラー: $e");
    }
  }

  Future<void> _checkAuthStatus() async {
    if (_requestId == null) return;
    if (_isCheckingStatus) return;
    setState(() { _isCheckingStatus = true; });

    try {
      await Future.delayed(const Duration(seconds: 1)); 

      final doc = await FirebaseFirestore.instance.collection('auth_requests').doc(_requestId).get();
      if (!doc.exists) return;

      final data = doc.data();
      final status = data?['status'];

      if (status == 'approved') {
        _showSuccess();
      } else if (status == 'rejected') {
        _showError("管理者に否認されました");
      } else {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("まだ承認されていません")));
      }
    } catch (e) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("確認エラー: $e")));
    } finally {
      if (mounted) setState(() { _isCheckingStatus = false; });
    }
  }

  void _showSuccess() {
    if (!mounted) return;
    setState(() { _step = 3; _message = "認証成功！\n出席が記録されました。"; });
  }

  void _showError(String msg) {
    if (!mounted) return;
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => AlertDialog(
        title: const Text("エラー"),
        content: Text(msg),
        actions: [
          TextButton(onPressed: () {
            Navigator.pop(context); 
            Navigator.pop(context); 
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
            if (_step == 1 && _cameraController != null && _cameraController!.value.isInitialized)
              Container(
                height: 300, width: 300, margin: const EdgeInsets.only(bottom: 20),
                child: ClipOval(
                  child: OverflowBox(
                    alignment: Alignment.center,
                    child: FittedBox(
                      fit: BoxFit.cover,
                      child: SizedBox(
                        width: _cameraController!.value.previewSize!.height,
                        height: _cameraController!.value.previewSize!.width,
                        child: CameraPreview(_cameraController!)
                      ),
                    ),
                  ),
                ),
              ),
            
            if (_step == 2 && widget.authType == 'code')
              Container(
                width: 300, height: 300, padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: Colors.black87, borderRadius: BorderRadius.circular(10)),
                child: CustomPaint(painter: ColorCodePainter(_myColorCode)),
              ),
            
            if (_step == 2 && widget.authType == 'nfc')
              const Icon(Icons.nfc, size: 100, color: Colors.blue),

            const SizedBox(height: 20),
            
            if (_step == 2) ...[
              ElevatedButton.icon(
                onPressed: _isCheckingStatus ? null : _checkAuthStatus,
                icon: _isCheckingStatus 
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) 
                    : const Icon(Icons.refresh),
                label: const Text("承認結果を確認する"),
              ),
            ],
            
            const SizedBox(height: 20),
            
            Text(_message, textAlign: TextAlign.center, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
            
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

// ==========================================
//   4. プレースホルダー画面群
// ==========================================

class CheckHistoryScreen extends StatelessWidget {
  const CheckHistoryScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text("出席履歴")), body: const Center(child: Text("履歴機能は準備中です")));
}
class CurriculumScreen extends StatelessWidget {
  const CurriculumScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text("カリキュラム")), body: const Center(child: Text("教材機能は準備中です")));
}
class FormScreen extends StatelessWidget {
  const FormScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text("連絡フォーム")), body: const Center(child: Text("フォーム機能は準備中です")));
}
class CalendarScreen extends StatelessWidget {
  const CalendarScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text("カレンダー")), body: const Center(child: Text("カレンダー機能は準備中です")));
}
class PortfolioScreen extends StatelessWidget {
  const PortfolioScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text("ポートフォリオ")), body: const Center(child: Text("ポートフォリオ機能は準備中です")));
}
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text("設定")), body: const Center(child: Text("設定機能は準備中です")));
}

// ==========================================
//   ヘルパー & ロジック
// ==========================================

class ColorCodePainter extends CustomPainter {
  final List<String> codes;
  ColorCodePainter(this.codes);

  @override
  void paint(Canvas canvas, Size size) {
    final double w = size.width;
    final double h = size.height;
    
    final double markerLen = w * 0.15;
    final redPen = Paint()..color = Colors.red..style = PaintingStyle.stroke..strokeWidth = 8.0;
    final bluePen = Paint()..color = Colors.blue..style = PaintingStyle.stroke..strokeWidth = 8.0;

    canvas.drawPath(Path()..moveTo(0, markerLen)..lineTo(0, 0)..lineTo(markerLen, 0), redPen);
    canvas.drawPath(Path()..moveTo(w - markerLen, 0)..lineTo(w, 0)..lineTo(w, markerLen), redPen);
    canvas.drawPath(Path()..moveTo(0, h - markerLen)..lineTo(0, h)..lineTo(markerLen, h), bluePen);
    canvas.drawPath(Path()..moveTo(w - markerLen, h)..lineTo(w, h)..lineTo(w, h - markerLen), bluePen);

    final double boxW = w * 0.52; 
    final double boxH = (h / 3) * 0.8;
    
    final double left = (w - boxW) / 2;
    final double top = (h - boxH) / 2;

    final double unitX = boxW / 19;
    final double unitY = boxH / 9;

    _drawColorBox(canvas, codes[0], left + unitX * 5, top, unitX, boxH); 
    _drawColorBox(canvas, codes[3], left + unitX * 13, top, unitX, boxH); 
    
    final double barTopY = top + unitY * 3;
    final double barBottomY = top + unitY * 4;
    _drawColorBox(canvas, codes[1], left + unitX * 6, top, unitX * 7, barTopY - top); 
    _drawColorBox(canvas, codes[2], left + unitX * 6, barBottomY, unitX * 7, (top + boxH) - barBottomY); 
    
    final whitePaint = Paint()..color = Colors.white..style = PaintingStyle.fill;
    canvas.drawRect(Rect.fromLTRB(left + unitX * 6, barTopY, left + unitX * 13, barBottomY), whitePaint);
  }

  void _drawColorBox(Canvas canvas, String code, double x, double y, double w, double h) {
    Color c = Colors.grey;
    if (code == "C") c = Colors.cyan;
    if (code == "Y") c = Colors.yellow;
    if (code == "M") c = Colors.purpleAccent; 
    if (code == "G") c = Colors.green;
    final paint = Paint()..color = c..style = PaintingStyle.fill;
    canvas.drawRect(Rect.fromLTWH(x, y, w, h), paint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class FaceVerification {
  static late FaceVerification instance;
  Interpreter? _interpreter;
  final FaceDetector _faceDetector = FaceDetector(options: FaceDetectorOptions(performanceMode: FaceDetectorMode.fast));
  Map<String, List<Float32List>> _registeredFaces = {};

  static Future<void> init() async {
    instance = FaceVerification();
    await instance._loadModel();
  }

  Future<void> _loadModel() async {
    try {
      _interpreter = await Interpreter.fromAsset('assets/mobilefacenet.tflite');
      debugPrint("モデルロード成功");
    } catch (e) {
      debugPrint("モデルロード失敗: $e");
    }
  }

  Future<bool> verifyUser(CameraImage cameraImage, String targetName, InputImageRotation rotation) async {
    if (_interpreter == null) return false;
    List<Float32List> userDescriptors = await _fetchUserDescriptors(targetName);
    if (userDescriptors.isEmpty) return false; 

    final inputImage = _inputImageFromCameraImage(cameraImage, rotation);
    if (inputImage == null) return false;

    final faces = await _faceDetector.processImage(inputImage);
    if (faces.isEmpty) return false;

    final bestFace = faces.reduce((a, b) => a.boundingBox.width > b.boundingBox.width ? a : b);
    final img_lib.Image? croppedImage = _cropFace(cameraImage, bestFace, rotation);
    if (croppedImage == null) return false;

    final Float32List currentDescriptor = _getEmbedding(croppedImage);

    double minDistance = double.infinity;
    for (final savedDescriptor in userDescriptors) {
      double dist = 0.0;
      for (int i = 0; i < savedDescriptor.length; i++) {
        dist += (savedDescriptor[i] - currentDescriptor[i]) * (savedDescriptor[i] - currentDescriptor[i]);
      }
      if (dist < minDistance) minDistance = dist;
    }
    return minDistance < 1.0; 
  }

  Float32List _getEmbedding(img_lib.Image image) {
    final imageBytes = image.toUint8List();
    final Float32List inputBytes = Float32List(1 * 112 * 112 * 3);
    int pixelIndex = 0;
    for (int i = 0; i < imageBytes.length; i += 3) {
      inputBytes[pixelIndex++] = (imageBytes[i + 2] / 127.5) - 1.0; 
      inputBytes[pixelIndex++] = (imageBytes[i + 1] / 127.5) - 1.0; 
      inputBytes[pixelIndex++] = (imageBytes[i]     / 127.5) - 1.0; 
    }
    final input = inputBytes.reshape([1, 112, 112, 3]);
    final output = List.filled(1 * 192, 0.0).reshape([1, 192]);
    _interpreter!.run(input, output);
    return Float32List.fromList(output[0]);
  }

  Future<List<Float32List>> _fetchUserDescriptors(String name) async {
    if (_registeredFaces.containsKey(name)) return _registeredFaces[name]!;
    try {
      final doc = await FirebaseFirestore.instance.collection('faces').doc(name).get();
      if (!doc.exists) return [];
      final data = doc.data();
      if (data == null || data['descriptors'] == null) return [];
      List<dynamic> rawList = data['descriptors'];
      List<Float32List> descriptors = rawList.map((base64Str) {
        final Uint8List bytes = base64Decode(base64Str);
        return bytes.buffer.asFloat32List();
      }).toList();
      _registeredFaces[name] = descriptors;
      return descriptors;
    } catch (e) {
      return [];
    }
  }
}

InputImage? _inputImageFromCameraImage(CameraImage image, InputImageRotation? rotation) {
  if (rotation == null) return null;
  final WriteBuffer allBytes = WriteBuffer();
  for (final Plane plane in image.planes) {
    allBytes.putUint8List(plane.bytes);
  }
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
    convertedImage = img_lib.Image(width: image.width, height: image.height, format: img_lib.Format.uint8, numChannels: 3);
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
          final int uvx = x ~/ 2; final int uvy = y ~/ 2;
          final int uIndex = uvy * uRowStride + uvx * uPixelStride;
          final int vIndex = uvy * vRowStride + uvx * vPixelStride;
          final int yValue = image.planes[0].bytes[yIndex];
          final int uValue = image.planes[1].bytes[uIndex];
          final int vValue = image.planes[2].bytes[vIndex];
          _setPixelRGB(convertedImage, x, y, yValue, uValue, vValue);
        }
      }
    } else if (image.planes.length == 2) {
      final int uvRowStride = image.planes[1].bytesPerRow;
      final int uvPixelStride = image.planes[1].bytesPerPixel ?? 2;
      for (int y = 0; y < height; y++) {
        for (int x = 0; x < width; x++) {
          final int yIndex = y * yRowStride + x;
          final int uvx = x ~/ 2; final int uvy = y ~/ 2;
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
  } else { return null; }

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
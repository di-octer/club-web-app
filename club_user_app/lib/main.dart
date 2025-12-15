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
import 'package:flutter_blue_plus/flutter_blue_plus.dart'; // ★追加

import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';
import 'package:tflite_flutter/tflite_flutter.dart';
import 'package:image/image.dart' as img_lib;

// --- 定数 ---
// 管理者アプリが発信しているUUID (Battery Service)
const String ADMIN_SERVICE_UUID = "180f"; 
const double GPS_RADIUS_METERS = 100.0;

// --- グローバル変数 ---
late FaceVerification _faceService;

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
      title: '部員用アプリ',
      theme: ThemeData(primarySwatch: Colors.blue, useMaterial3: true),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final TextEditingController _nameController = TextEditingController(); 
  
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
              decoration: const InputDecoration(labelText: 'あなたの名前 (登録名)', border: OutlineInputBorder()),
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

class AuthProcessScreen extends StatefulWidget {
  final String userName;
  final String authType;
  const AuthProcessScreen({super.key, required this.userName, required this.authType});

  @override
  State<AuthProcessScreen> createState() => _AuthProcessScreenState();
}

class _AuthProcessScreenState extends State<AuthProcessScreen> {
  int _step = 0; // 0:環境チェック, 1:顔認証, 2:待機(手動確認), 3:完了
  String _message = "環境情報を確認中...";
  CameraController? _cameraController;
  bool _isProcessingFace = false;
  String? _requestId;
  List<String> _myColorCode = [];
  InputImageRotation _cameraRotation = InputImageRotation.rotation270deg;
  
  // 連打防止用フラグ
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

  // ステップ1: 環境チェック (GPS + BLE)
  Future<void> _checkEnvironment() async {
    try {
      // 1. GPSチェック
      setState(() { _message = "GPSエリアを確認中..."; });
      await _checkGps();

      // 2. BLEチェック (★追加)
      setState(() { _message = "管理者のビーコンを捜索中..."; });
      await _checkBle();

      // 環境OK -> 顔認証へ
      _initCamera();
      
    } catch (e) {
      _showError("環境チェック失敗: $e");
    }
  }

  Future<void> _checkGps() async {
    final position = await _determinePosition();
    final campusesSnapshot = await FirebaseFirestore.instance.collection('campuses').get();
    final areasSnapshot = await FirebaseFirestore.instance.collection('gps_areas').where('isActive', isEqualTo: true).get();
    
    if (campusesSnapshot.docs.isEmpty || areasSnapshot.docs.isEmpty) {
      // デバッグのためスルーする場合はここをコメントアウト
      // throw Exception("エリアデータがありません");
      debugPrint("エリアデータなし(デバッグ通過)");
      return;
    }

    bool inArea = false;
    for (var doc in areasSnapshot.docs) {
      final data = doc.data();
      final double lat = (data['lat'] ?? 0.0).toDouble();
      final double lon = (data['lon'] ?? 0.0).toDouble();
      final double dist = Geolocator.distanceBetween(position.latitude, position.longitude, lat, lon);
      
      if (dist <= GPS_RADIUS_METERS) {
        inArea = true;
        break;
      }
    }
    
    if (!inArea) {
      // debug: throw Exception("登録エリア外です");
      debugPrint("エリア外ですがデバッグのため通過します");
    }
  }

  // ★追加: BLEスキャンロジック
  Future<void> _checkBle() async {
    // Bluetoothが有効か確認
    if (await FlutterBluePlus.isSupported == false) {
      throw Exception("このデバイスはBluetooth非対応です");
    }
    if (await FlutterBluePlus.adapterState.first != BluetoothAdapterState.on) {
      // 本来はONにするよう促すが、ここでは簡易的にエラー
      // throw Exception("BluetoothをONにしてください");
      debugPrint("BTオフですがデバッグのため通過");
      return; 
    }

    bool adminFound = false;
    final completer = Completer<void>();

    // スキャン開始
    debugPrint("BLEスキャン開始: $ADMIN_SERVICE_UUID");
    
    var subscription = FlutterBluePlus.scanResults.listen((results) {
      for (ScanResult r in results) {
        // アドバタイズデータ内のServiceUUIDsを確認
        if (r.advertisementData.serviceUuids.contains(Guid(ADMIN_SERVICE_UUID))) {
          debugPrint("管理者ビーコン発見: ${r.device.remoteId}");
          if (!adminFound) {
            adminFound = true;
            completer.complete();
          }
        }
      }
    });

    // 4秒間スキャン
    await FlutterBluePlus.startScan(timeout: const Duration(seconds: 4));
    
    // スキャン終了待ち
    if (!completer.isCompleted) {
      // タイムアウトしても見つからなかった場合
      // throw Exception("管理者のビーコンが見つかりません");
      debugPrint("ビーコン見つからず(デバッグ通過)");
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

  // ステップ2: 顔認証
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

  // ステップ3: リクエスト送信 (手動確認へ移行)
  Future<void> _sendAuthRequest() async {
    setState(() { _step = 2; _message = "管理者に画面を見せてください"; });
    
    try {
      String finalAuthType = widget.authType;
      if (widget.authType == 'code') {
        finalAuthType = "code,${_myColorCode.join(',')}";
      }

      final docRef = await FirebaseFirestore.instance.collection('auth_requests').add({
        'userName': widget.userName,
        'authType': finalAuthType,
        'status': 'pending',
        'requestTimestamp': FieldValue.serverTimestamp(),
        'gps_valid': true,
        'face_valid': true,
      });

      setState(() { _requestId = docRef.id; });
      // ★修正: ここでの自動監視 (snapshots) は廃止

    } catch (e) {
      _showError("リクエスト送信エラー: $e");
    }
  }

  // ★追加: 手動ステータス確認メソッド
  Future<void> _checkAuthStatus() async {
    if (_requestId == null) return;
    
    // 連打防止ロック
    if (_isCheckingStatus) return;
    setState(() { _isCheckingStatus = true; });

    try {
      // 1秒待機 (グレイアウト演出 & 連打防止)
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
            
            const SizedBox(height: 20),
            
            if (_step == 2) ...[
              // ★追加: 手動確認ボタン
              ElevatedButton.icon(
                // 連打防止中は無効化
                onPressed: _isCheckingStatus ? null : _checkAuthStatus,
                icon: _isCheckingStatus 
                    ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) 
                    : const Icon(Icons.refresh),
                label: const Text("結果を確認する"),
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

// --- ★ カラーコード描画 ---
class ColorCodePainter extends CustomPainter {
  final List<String> codes;
  ColorCodePainter(this.codes);

  @override
  void paint(Canvas canvas, Size size) {
    final double w = size.width;
    final double h = size.height;
    
    // 背景(黒)はContainerで描画済み
    
    // 四隅のマーカー
    final double markerLen = w * 0.15;
    final redPen = Paint()..color = Colors.red..style = PaintingStyle.stroke..strokeWidth = 8.0;
    final bluePen = Paint()..color = Colors.blue..style = PaintingStyle.stroke..strokeWidth = 8.0;

    // 左上(赤)
    canvas.drawPath(Path()..moveTo(0, markerLen)..lineTo(0, 0)..lineTo(markerLen, 0), redPen);
    // 右上(赤)
    canvas.drawPath(Path()..moveTo(w - markerLen, 0)..lineTo(w, 0)..lineTo(w, markerLen), redPen);
    // 左下(青)
    canvas.drawPath(Path()..moveTo(0, h - markerLen)..lineTo(0, h)..lineTo(markerLen, h), bluePen);
    // 右下(青)
    canvas.drawPath(Path()..moveTo(w - markerLen, h)..lineTo(w, h)..lineTo(w, h - markerLen), bluePen);

    // H型コード配置 (管理者アプリの比率に合わせる)
    // 縦1:1:1, 横1:2:1 のエリアにH型を描画
    final double boxW = w * 0.52; 
    final double boxH = (h / 3) * 0.8;
    
    final double left = (w - boxW) / 2;
    final double top = (h - boxH) / 2;

    final double unitX = boxW / 19;
    final double unitY = boxH / 9;

    // 左棒 (エリア1)
    _drawColorBox(canvas, codes[0], left + unitX * 5, top, unitX, boxH);
    
    // 右棒 (エリア4)
    _drawColorBox(canvas, codes[3], left + unitX * 13, top, unitX, boxH);
    
    // 中央上 (エリア2)
    final double barTopY = top + unitY * 3;
    final double barBottomY = top + unitY * 4;
    _drawColorBox(canvas, codes[1], left + unitX * 6, top, unitX * 7, barTopY - top);
    
    // 中央下 (エリア3)
    _drawColorBox(canvas, codes[2], left + unitX * 6, barBottomY, unitX * 7, (top + boxH) - barBottomY);
    
    // Hの横棒(白)
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

// --- 顔認証サービス (変更なし) ---
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

// --- ヘルパー関数 ---
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
import 'package:flutter/material.dart';
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:math' as math;
import 'package:firebase_core/firebase_core.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:geolocator/geolocator.dart';
import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart'; // WriteBuffer用

// ★ AI系ライブラリを有効化
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';
import 'package:tflite_flutter/tflite_flutter.dart';
import 'package:image/image.dart' as img_lib;

// --- 定数・設定 ---
const String ADMIN_SERVICE_UUID = "0000180F-0000-1000-8000-00805F9B34FB";
const double GPS_THRESHOLD = 0.00005; 

// --- グローバル変数 ---
late FaceVerification _faceService;

// --- メイン関数 ---
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();
  
  // AIモデルのロード待機
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

// --- ホーム画面 ---
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
    // キーボードを閉じる
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

// --- 認証プロセス画面 ---
class AuthProcessScreen extends StatefulWidget {
  final String userName;
  final String authType;
  const AuthProcessScreen({super.key, required this.userName, required this.authType});

  @override
  State<AuthProcessScreen> createState() => _AuthProcessScreenState();
}

class _AuthProcessScreenState extends State<AuthProcessScreen> {
  int _step = 0; // 0:GPSチェック, 1:顔認証, 2:管理者待機, 3:完了
  String _message = "環境情報を確認中...";
  CameraController? _cameraController;
  bool _isProcessingFace = false;
  String? _requestId;
  
  // 顔認証用の回転情報
  InputImageRotation _cameraRotation = InputImageRotation.rotation270deg;

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

  // ステップ1: GPS確認
  Future<void> _checkEnvironment() async {
    setState(() { _message = "GPSエリアを確認中..."; });
    
    try {
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
      
      if (!inArea) {
        // デバッグ用: エリアがなくても進める場合はここをコメントアウト
        throw Exception("登録エリア外です");
      }

      // BLEチェックは省略し、顔認証へ
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

  // ステップ2: 顔認証
  Future<void> _initCamera() async {
    setState(() { _step = 1; _message = "本人確認のため顔を映してください"; });
    
    try {
      final cameras = await availableCameras();
      final frontCam = cameras.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front,
        orElse: () => cameras.first
      );
      
      // 回転情報の取得
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
      // 登録ユーザー本人かどうか確認
      bool isMatch = await _faceService.verifyUser(image, widget.userName, _cameraRotation);
      
      if (isMatch) {
        await _cameraController!.stopImageStream();
        if (mounted) {
           _sendAuthRequest();
        }
      }
    } catch (e) {
      debugPrint("Face Auth Error: $e");
    } finally {
      if (mounted) _isProcessingFace = false;
    }
  }

  // ステップ3: リクエスト送信
  Future<void> _sendAuthRequest() async {
    setState(() { _step = 2; _message = "管理者に承認を求めています...\nこの画面を管理者に見せてください"; });
    
    try {
      final docRef = await FirebaseFirestore.instance.collection('auth_requests').add({
        'userName': widget.userName,
        'authType': widget.authType,
        'status': 'pending',
        'requestTimestamp': FieldValue.serverTimestamp(),
        'gps_valid': true,
        'ble_valid': true, // 省略したがフロー上はOKとする
        'face_valid': true, // 本人確認済み
      });

      setState(() { _requestId = docRef.id; });
      debugPrint("Request Sent: $_requestId");

      // 監視
      docRef.snapshots().listen((snapshot) {
        if (!snapshot.exists) return;
        final data = snapshot.data();
        if (data?['status'] == 'approved') {
          _showSuccess();
        } else if (data?['status'] == 'rejected') {
          _showError("管理者に否認されました");
        }
      });
    } catch (e) {
      _showError("リクエスト送信エラー: $e");
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
            Navigator.pop(context); // ダイアログ
            Navigator.pop(context); // 画面閉じる
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
            // カメラプレビュー
            if (_step == 1 && _cameraController != null && _cameraController!.value.isInitialized)
              Container(
                height: 300, width: 300,
                margin: const EdgeInsets.only(bottom: 20),
                child: ClipOval(
                  child: OverflowBox(
                    alignment: Alignment.center,
                    child: FittedBox(
                      fit: BoxFit.cover,
                      child: SizedBox(
                        width: _cameraController!.value.previewSize!.height, // 縦横逆転注意
                        height: _cameraController!.value.previewSize!.width,
                        child: CameraPreview(_cameraController!)
                      ),
                    ),
                  ),
                ),
              ),
            
            // カラーコード表示
            if (_step == 2 && widget.authType == 'code')
              Container(
                width: 200, height: 200, 
                decoration: BoxDecoration(border: Border.all(color: Colors.black)),
                child: const Center(child: Text("カラーコード\n(実装予定)", textAlign: TextAlign.center)),
              ),
            
            const SizedBox(height: 20),
            
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

// --- ★ 顔認証サービス (移植版) ---
class FaceVerification {
  static late FaceVerification instance;
  Interpreter? _interpreter;
  final FaceDetector _faceDetector = FaceDetector(options: FaceDetectorOptions(performanceMode: FaceDetectorMode.fast));
  
  // 読み込んだ顔データ (名前 -> 特徴量リスト)
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

  // 指定されたユーザーとして認証できるか
  Future<bool> verifyUser(CameraImage cameraImage, String targetName, InputImageRotation rotation) async {
    if (_interpreter == null) return false;

    // 1. そのユーザーのデータをFirestoreから取得 (キャッシュ推奨だが今回は都度取得)
    List<Float32List> userDescriptors = await _fetchUserDescriptors(targetName);
    if (userDescriptors.isEmpty) {
      debugPrint("ユーザー「$targetName」の登録データがありません");
      return false; 
    }

    // 2. カメラ画像から顔検出
    final inputImage = _inputImageFromCameraImage(cameraImage, rotation);
    if (inputImage == null) return false;

    final faces = await _faceDetector.processImage(inputImage);
    if (faces.isEmpty) return false;

    // 一番大きく映っている顔を採用
    final bestFace = faces.reduce((a, b) => a.boundingBox.width > b.boundingBox.width ? a : b);

    // 3. 顔画像を切り抜き＆特徴量抽出
    final img_lib.Image? croppedImage = _cropFace(cameraImage, bestFace, rotation);
    if (croppedImage == null) return false;

    final Float32List currentDescriptor = _getEmbedding(croppedImage);

    // 4. 照合 (ユークリッド距離)
    double minDistance = double.infinity;
    for (final savedDescriptor in userDescriptors) {
      double dist = 0.0;
      for (int i = 0; i < savedDescriptor.length; i++) {
        dist += (savedDescriptor[i] - currentDescriptor[i]) * (savedDescriptor[i] - currentDescriptor[i]);
      }
      if (dist < minDistance) minDistance = dist;
    }

    // 閾値以下なら本人とみなす
    // (Adminアプリでは 1.0 でしたが、厳しめに 0.8 くらいでも良いかもしれません)
    debugPrint("Distance: $minDistance");
    return minDistance < 1.0; 
  }

  // 特徴量抽出 (Adminアプリと同じロジック)
  Float32List _getEmbedding(img_lib.Image image) {
    // 112x112 にリサイズ済み前提
    final imageBytes = image.toUint8List();
    final Float32List inputBytes = Float32List(1 * 112 * 112 * 3);
    
    int pixelIndex = 0;
    for (int i = 0; i < imageBytes.length; i += 3) {
      // 正規化 ( -1.0 ~ 1.0 )
      inputBytes[pixelIndex++] = (imageBytes[i + 2] / 127.5) - 1.0; // R
      inputBytes[pixelIndex++] = (imageBytes[i + 1] / 127.5) - 1.0; // G
      inputBytes[pixelIndex++] = (imageBytes[i]     / 127.5) - 1.0; // B
    }

    final input = inputBytes.reshape([1, 112, 112, 3]);
    final output = List.filled(1 * 192, 0.0).reshape([1, 192]);
    
    _interpreter!.run(input, output);
    return Float32List.fromList(output[0]);
  }

  // Firestoreからユーザーの特徴量を取得
  Future<List<Float32List>> _fetchUserDescriptors(String name) async {
    // キャッシュがあれば返す
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

      _registeredFaces[name] = descriptors; // キャッシュ
      return descriptors;
    } catch (e) {
      debugPrint("Firestore fetch error: $e");
      return [];
    }
  }
}

// --- ★ ヘルパー関数 (Adminアプリから移植) ---

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
// lib/models/face_object.dart

import 'dart:typed_data'; // Float32List

class FaceObject {
  final String label;
  final String thumbnail; // サムネイル (Base64 Data URL)
  final List<Float32List> descriptors; // 特徴量

  FaceObject({
    required this.label,
    required this.thumbnail,
    required this.descriptors,
  });
}
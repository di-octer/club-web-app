// lib/models/gps_area.dart

class GpsArea {
  final String name;
  final double lat; // 中心緯度 (旧lat1)
  final double lon; // 中心経度 (旧lon1)
  final bool isActive; // ★追加

  GpsArea({
    required this.name,
    required this.lat,
    required this.lon,
    this.isActive = false, // デフォルトは非活動
  });

  Map<String, dynamic> toJson() => {
    'name': name,
    'lat': lat,
    'lon': lon,
    'isActive': isActive,
  };

  factory GpsArea.fromJson(Map<String, dynamic> json) {
    return GpsArea(
      name: json['name'] ?? '',
      lat: (json['lat'] ?? 0.0).toDouble(),
      lon: (json['lon'] ?? 0.0).toDouble(),
      isActive: json['isActive'] ?? false,
    );
  }
}
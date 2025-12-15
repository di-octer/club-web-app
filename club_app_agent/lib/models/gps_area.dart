class GpsArea {
  final String name;
  final String campusId; // ★追加
  final double lat;
  final double lon;
  final bool isActive;

  GpsArea({
    required this.name,
    required this.campusId, // ★追加
    required this.lat,
    required this.lon,
    this.isActive = false,
  });

  Map<String, dynamic> toJson() => {
    'name': name,
    'campusId': campusId, // ★追加
    'lat': lat,
    'lon': lon,
    'isActive': isActive,
  };

  factory GpsArea.fromJson(Map<String, dynamic> json) {
    return GpsArea(
      name: json['name'] ?? '',
      campusId: json['campusId'] ?? '', // ★追加 (既存データがない場合は空文字)
      lat: (json['lat'] ?? 0.0).toDouble(),
      lon: (json['lon'] ?? 0.0).toDouble(),
      isActive: json['isActive'] ?? false,
    );
  }
}
// lib/models/gps_area.dart

class GpsArea {
  final String name;
  final double lat1;
  final double lon1;
  final double lat2;
  final double lon2;

  GpsArea({
    required this.name,
    required this.lat1,
    required this.lon1,
    required this.lat2,
    required this.lon2,
  });

  // Firestore の Map (JSON) から GpsArea オブジェクトに変換する
  factory GpsArea.fromJson(Map<String, dynamic> json) {
    return GpsArea(
      name: json['name'] as String,
      lat1: (json['lat1'] as num).toDouble(),
      lon1: (json['lon1'] as num).toDouble(),
      lat2: (json['lat2'] as num).toDouble(),
      lon2: (json['lon2'] as num).toDouble(),
    );
  }

  // GpsArea オブジェクトを Firestore に保存する Map (JSON) に変換する
  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'lat1': lat1,
      'lon1': lon1,
      'lat2': lat2,
      'lon2': lon2,
    };
  }
}
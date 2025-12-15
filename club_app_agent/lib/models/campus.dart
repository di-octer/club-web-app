class Campus {
  final String id; // FirestoreのドキュメントID
  final String name;
  final double lat;
  final double lon;

  Campus({required this.id, required this.name, required this.lat, required this.lon});

  Map<String, dynamic> toJson() => {
    'name': name,
    'lat': lat,
    'lon': lon,
  };

  factory Campus.fromSnapshot(String id, Map<String, dynamic> json) {
    return Campus(
      id: id,
      name: json['name'] ?? '',
      lat: (json['lat'] ?? 0.0).toDouble(),
      lon: (json['lon'] ?? 0.0).toDouble(),
    );
  }
}
use http::HeaderMap;

use crate::error::{CommonErrorDerivative, Error};

pub(crate) fn has_version_query(query: Option<&str>) -> bool {
	query.is_some_and(|query| {
		form_urlencoded::parse(query.as_bytes()).any(|(name, _)| name == "versionId")
	})
}

// Reject options that would otherwise be acknowledged without being applied.
pub(crate) fn validate_storage_options(headers: &HeaderMap) -> Result<(), Error> {
	for value in headers.get_all("x-amz-storage-class") {
		if value.as_bytes() != b"STANDARD" {
			return Err(Error::bad_request(
				"Only the STANDARD storage class is supported",
			));
		}
	}
	for name in headers.keys() {
		let name = name.as_str();
		if name.starts_with("x-amz-object-lock-")
			|| name == "x-amz-bucket-object-lock-enabled"
			|| name == "x-amz-bypass-governance-retention"
		{
			return Err(Error::bad_request("Object Lock is not supported"));
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn detects_empty_and_encoded_version_queries() {
		assert!(!has_version_query(None));
		assert!(!has_version_query(Some("versionMarker=old")));
		assert!(has_version_query(Some("versionId=")));
		assert!(has_version_query(Some("version%49d=old")));
	}

	#[test]
	fn rejects_unimplemented_storage_options() {
		let mut headers = HeaderMap::new();
		assert!(validate_storage_options(&headers).is_ok());
		headers.insert("x-amz-storage-class", "STANDARD".parse().unwrap());
		assert!(validate_storage_options(&headers).is_ok());
		headers.append("x-amz-storage-class", "GLACIER".parse().unwrap());
		assert!(validate_storage_options(&headers).is_err());
		headers.remove("x-amz-storage-class");
		headers.insert("x-amz-object-lock-mode", "COMPLIANCE".parse().unwrap());
		assert!(validate_storage_options(&headers).is_err());
		headers.remove("x-amz-object-lock-mode");
		headers.insert("x-amz-bucket-object-lock-enabled", "true".parse().unwrap());
		assert!(validate_storage_options(&headers).is_err());
	}
}

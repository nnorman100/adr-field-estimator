project_id  = "alert-disaster-field-2026"
region      = "us-central1"
environment = "test"

# Shared-core tier: synthetic load only, no SQL SLA.
sql_tier                  = "db-f1-micro"
sql_disk_size_gb          = 10
sql_backup_retained_count = 7
sql_pitr_log_days         = 3

evidence_soft_delete_days = 7
